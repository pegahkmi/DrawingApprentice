/**
 * @author Chih-Pin Hsiao
 * @email: chipin01@gmail.com
 */
"use strict";
process.title = 'sketch-service';

var oneDay = 86400000;

// initialize required module
var express = require('express'),
    passport = require('passport'),
    util = require('util'),
    session = require('express-session'),
    cookieParser = require('cookie-parser'),
    bodyParser = require('body-parser'),
    strategies = require('./strategies'),
    http = require('http'),
    app = express(),
    canvas2D = require('./libImage'),
    uuid = require('node-uuid'),
    zerorpc,
    curRooms = {},
    roomsInfo = [],
    onlineUsers = {},
    Room = require('./lib_GameHall/gameroom');

// try to load zero rpc (the connection util for getting sketch recognizer result)
try {
    zerorpc = require("zerorpc");
} catch (err) {
    console.error(err);
}

Array.prototype.remove = function(index){
  this.splice(index,1);
}

// ZERO RPC UTILITY
var options = {timeout:600000};
// setting up the local connection to sketch classifier
var sketchClassfier;
if (zerorpc) {
    sketchClassfier = new zerorpc.Client(options);
    sketchClassfier.connect("tcp://127.0.0.1:4242");
}

// Passport session setup for facebook and google authentication
passport.serializeUser(function (user, done) {
    done(null, user);
});
passport.deserializeUser(function (obj, done) {
    done(null, obj);
});

// Use various strategies.
passport.use(strategies.Facebook);
passport.use(strategies.Google);

//=====================Set Up Express App=====================\\
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({ secret: 'keyboard cat', key: 'sid' }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname + '/public'));
app.use('/session_pic', express.static(__dirname + '/session_pic'));

// log-in page for now
app.get('/', function (req, res) {
    res.render('index', { user: req });
});

app.get('/admin_room/create', function (req, res) {
    res.json(roomsInfo);
});

app.post('/admin_room/create', function (req, res) {
    var roomInfo = req.body;
    var newRoomInfo = {};
    newRoomInfo.fullpic = '';
    newRoomInfo.id = uuid.v4();
    newRoomInfo.host = "chipin01"; // hard-coded for now;
    newRoomInfo.players = [];
    canvas2D.CreateBlankThumb(newRoomInfo.id);
    newRoomInfo.thumb = '../session_pic/' + newRoomInfo.id + '_thumb.png';
    roomsInfo.push(newRoomInfo);
    // create a room
    var room = new Room(newRoomInfo, sketchClassfier);
    curRooms[newRoomInfo.id] = room;

    // Todo: remember to redirect the client to the app page
    res.json(newRoomInfo);
});

app.post('/admin_room/join', function (req, res) {
    // 1. check if the room exists
    var msg = req.body;
    var room = curRooms[msg.id]; 
    var roomInfo = room ? room.roomInfo : null;

	function addIfPlayerExists(id, newPlayer){
		var isExist = false;
		for(var i=0;i<roomInfo.players.length;i++){
			if(roomInfo.players == id){
				isExist = true;
				break;
			}
		}
		if(!isExist){
			roomInfo.players.push(msg.newPlayer.id);
		}
		newPlayer.curRoom = roomInfo.id;
		room.players.push(newPlayer);
	}

    // 2. if yes, then add a player inside of the room.players attributes
    //   so that the room knows there is a new player joining in.
    if (room && roomInfo && onlineUsers[msg.newPlayer.id]) {
        console.log("player: " + msg.newPlayer.id + " is joining the room");
        var newPlayer = onlineUsers[msg.newPlayer.id];
        addIfPlayerExists(msg.newPlayer.id, newPlayer);
        
        // 3. tell the client to redirect to app page
        var rmsg = {isSucceed: true};
        res.json(rmsg);
    }
});

// For admin to delete a room
app.post('/admin_room/delete', function (req, res){
    var msg = req.body;
    var rmsg = {isSucceed: false};
    console.log(msg.requester);
    if(curRooms[msg.id] && msg.requester == "105775598272793470839"){	        
	delete curRooms[msg.id];
	for(var i=0;i<roomsInfo.length;i++){
	    if(roomsInfo[i].id == msg.id){
	    	roomsInfo.remove(i);
		break;
	    }	
	}
    }
    res.json(rmsg);
});

// ensure authentication
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.redirect('/DrawingApprentice/');
}
function authenticationSucceed(req, res){
    console.log("user " + req.user.id + " logged in");
    onlineUsers[req.user.id] = req.user;
    res.redirect('/admin_room/');//res.redirect('/app');
}

// if the user pass thorugh authentication, render the app
app.get('/app', ensureAuthenticated, function (req, res) {
    console.log("client start accessing app resources");
    var user = onlineUsers[req.user.id];
    var roomID = '';
    if(user){
        roomID = user.curRoom;
    }
    // need to tell the client to load the existing jpg
    res.render('app', { user: req.user._raw, sessionId: req.sessionID, roomId: roomID});
});

// facebook authentication
app.get('/auth/facebook', passport.authenticate('facebook', { scope: 'email' }));
app.get('/auth/facebook/callback',
    passport.authenticate('facebook', { failureRedirect: '/' }),
    authenticationSucceed
);
// google authentication
app.get('/auth/google', passport.authenticate('google', { scope: 'https://www.googleapis.com/auth/plus.login' }));
app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    authenticationSucceed
);
// when log-out
app.get('/logout', function (req, res) {
    req.logout();
    res.redirect('/DrawingApprentice/');
});
// Start to listen the app
app.listen(3000);
//===================== Finished Express App Set Up ===================\\


//===================== Set up socket io server =====================\\
var server = http.Server(app);
var io = require('socket.io')(server);
server.listen(8080); // for local debug

io.on('connection', function (so) {
    // set up closure varialbes
    var utilDatabase = require('./libDatabase');
    var room; //this is the game room, grab the data from here rather than apprentice 
    var userProfile;
    var sessionID;

    // sending "handshake" message
    so.emit('newconnection', { hello: "world" });

    // getting "handshake" message
    function onOpen(hello) {
        if (hello) {
            var thisPlayer;
            if (onlineUsers[hello.user.id]) {
                thisPlayer = onlineUsers[hello.user.id];
                room = curRooms[thisPlayer.curRoom];
                room.sockets.push(so);
            }
            
            // should not go into the !room case
            // this is for debug purposes
            if (!room) {
                room = new Room(null, sketchClassfier);
            }

            room.setCanvasSize(hello.width, hello.height);
            userProfile = hello.user;
            sessionID = thisPlayer ? thisPlayer.curRoom : uuid.v4();
            
            utilDatabase.initializeParameters(userProfile, sessionID, apprentice, room.canvasSize);
        }
    }

    function onNewStrokeReceived(data) {
        var d = JSON.parse(data);

        var stroke = d.data;
        room.addStroke(stroke, so);
    }

    function submit(info) {
        var info = JSON.parse(info); 
        room.updateVoteResult(info);
    }

    function onClear() {
        room.clearCanvas();    
    }

    so.on('onOpen', onOpen);
    so.on('touchdown', function () {
       room.resetTimeout();
    });
    so.on('touchup', onNewStrokeReceived);
    so.on('disconnect', utilDatabase.onSaveDataOnDb);
    so.on('clear', onClear);
    so.on('submit', submit);
});

console.log("SocketIO Server Initialized!");