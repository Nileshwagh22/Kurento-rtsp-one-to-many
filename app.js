var kurento = require('kurento-client');
var express = require('express');
var app = express();
var path = require('path');
var url = require('url');
var wsm = require('ws');
var fs    = require('fs');
var https = require('https');

app.set('port', process.env.PORT || 8080);

/*
 * Definition of constants
 */

const
ws_uri = "ws://localhost:8888/kurento",
rtsp_uri = "rtsp://192.168.15.189:8554/testStream";

/*
 * Definition of global variables.
 */

var idCounter = 0;
var candidatesQueue = {};
var master = null;
var pipeline = null;
var viewers = {};
var kurentoClient = null;

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}
/*
 * Server startup
 */

var port = app.get('port');
/*
var server = app.listen(port, function() {
	console.log('Express server started ');
	console.log('Connect to http://<host_name>:' + port + '/');
});*/

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var server = https.createServer(options, app).listen(port, function() {
    console.log('********************Kurento Tutorial started');
    //console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var WebSocketServer = wsm.Server, wss = new WebSocketServer({
	server : server,
	path : '/one2many'
});

// Master Stream hasn't been set
startRTSP(function(error) {
	console.log('**********************startRTSP(function(error) {');
	if (error) {
		return console.error(error);
	}
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();

	console.log('************************Connection received with sessionId ' + sessionId);

	ws.on('error', function(error) {
		console.log('*********************Connection ' + sessionId + ' error');
		stop(sessionId);
	});

	ws.on('close', function() {
		console.log('**************************Connection ' + sessionId + ' closed');
		stop(sessionId);
	});

	ws.on('message', function(_message) {
		var message = JSON.parse(_message);
		console.log('*************************Connection ' + sessionId + ' received message ', message);

		switch (message.id) {

		case 'viewer':

			startViewer(sessionId, message.sdpOffer, ws, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

		case 'stop':
			stop(sessionId);
			break;
			
		case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

		default:
			ws.send(JSON.stringify({
				id : 'error',
				message : 'Invalid message ' + message
			}));
			break;
		}
	});
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
	if (kurentoClient !== null) {
		return callback(null, kurentoClient);
	}

	kurento(ws_uri, function(error, _kurentoClient) {
		if (error) {
			console.log("*******************Coult not find media server at address " + ws_uri);
			return callback("Could not find media server at address" + ws_uri
					+ ". Exiting with error " + error);
		}

		kurentoClient = _kurentoClient;
		callback(null, kurentoClient);
	});
}

/* Start PlayerEndpoint instead */
function startRTSP(callback) {
	console.log('********************function startRTSP(callback) {');
	if (master !== null) {
		return callback("Master is already running ...");
	}

	master = true;

	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(id);
			return callback(error);
		}

		kurentoClient.create('MediaPipeline', function(error, _pipeline) {
			if (error) {
				return callback(error);
			}

			// PlayerEndpoint params
			var params = {
				mediaPipeline: _pipeline,
				uri: rtsp_uri,
				useEncodedMedia: true // true
			};

			pipeline = _pipeline;
			pipeline.create('PlayerEndpoint', params, function(error, PlayerEndpoint) {
				if (error) {
					return callback(error);
				}

				console.log('***************Preparing to play');
				PlayerEndpoint.play(function() {
					console.log('**************Now playing');
				});

			});

		});
	});
}

function startViewer(id, sdp, ws, callback) {
	console.log('***************startViewer(id, sdp, ws, callback) {');
	if (master === null || master.webRtcEndpoint === null) {
		return callback("No active streams available. Try again later ...");
	}

	if (viewers[id]) {
		return callback("You are already viewing in this session. Use a different browser to add additional viewers.")
	}

	pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		console.log("**************pipeline.create('WebRtcEndpoint',");
		if (error) {
			return callback(error);
		}

		if (master === null) {
			stop(id);
			return callback("No active streams available. Try again later ...");
		}
		
		
		var viewer = {
			id : id,
			ws : ws,
			webRtcEndpoint : webRtcEndpoint
		};
		viewers[viewer.id] = viewer;

		master = {webRtcEndpoint: webRtcEndpoint};
		
		
		if (candidatesQueue[id]) {
			while(candidatesQueue[id].length) {
				var candidate = candidatesQueue[id].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
			console.log("**************webRtcEndpoint.on('OnIceCandidate', function(event) {");
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });
		
		webRtcEndpoint.processOffer(sdp, function(error, sdpAnswer) {
			console.log("**************webRtcEndpoint.processOffer(sdp,");
			if (error) {
				stop(id);
				return callback(error);
			}

			if (master === null) {
				stop(id);
				return callback("No active streams available. Try again later ...");
			}

			master.webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				console.log("**************master.webRtcEndpoint.connect(webRtcEndpoint");
				if (error) {
					stop(id);
					return callback(error, getState4Client());
				}

				if (master === null) {
					stop(id);
					return callback("No active sender now. Become sender or . Try again later ...");
				}

				/*var viewer = {
					id : id,
					ws : ws,
					webRtcEndpoint : webRtcEndpoint
				};
				viewers[viewer.id] = viewer;*/

				return callback(null, sdpAnswer);
			});
		});
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    /*if (presenter && presenter.id === sessionId && presenter.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        presenter.webRtcEndpoint.addIceCandidate(candidate);
    }*/
	
	/*if (master && master.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        master.webRtcEndpoint.addIceCandidate(candidate);
    }
    else*/ if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
        console.info('***************Sending viewer candidate');
        viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

function stop(id) {
	if (viewers[id]) {
		var viewer = viewers[id];
		if (viewer.webRtcEndpoint)
			viewer.webRtcEndpoint.release();
		delete viewers[id];

		pipeline.release();
		pipeline = null;
		master = null;
	}
	clearCandidatesQueue(id);
}

app.use(express.static(path.join(__dirname, 'static')));