"use strict";

const wsClient = require('websocket').client;
const EventEmitter = require('events');
const util = require('util');
const https = require('https');
const url = require('url');

const User = require('./classes/user.js');
const Room = require('./classes/room.js');
const Message = require('./classes/message.js');
const Tools = require('./tools.js');
const Data = {};


class Client extends EventEmitter {
	constructor (opts) {
		super();
		if (!opts) return console.error("Umm, you missed the configuration options...");
		this.opts = {
			server: opts.server || 'sim.smogon.com',
			serverid: 'showdown',
			port: opts.port || 8000,
			connectionTimeout: opts.connectionTimeout || (2 * 60 * 1000),
			loginServer: opts.loginServer || "https://play.pokemonshowdown.com/~~showdown/action.php",
			username: opts.username,
			password: () => opts.password,
			avatar: opts.avatar,
			status: opts.status,
			retryLogin: typeof opts.retryLogin === 'number' ? opts.retryLogin : 10 * 1000,
			autoReconnect: typeof opts.autoReconnect === 'number' ? opts.autoReconnect : 30 * 1000,
			autoJoin: opts.autoJoin
		}
		this.actionURL = url.parse(this.opts.loginServer);
		this.isTrusted = null;
		this.rooms = {};
		this.users = {};
		this.status = {
			connected: false,
			loggedIn: false,
			username: null
		}
		this.closed = true;
		this.queue = [];
		this.queued = [];
		this.userdetailsQueue = []; // {id: string, resolve: resolve, reject: reject}

		this.debug = opts.debug ? console.log : () => {};
		this.handle = opts.handle === null ? () => {} : (typeof opts.handle === 'function' ? opts.handle : console.error);
	}

	// Websocket
	connect (re) {
		if (re) console.log('Retrying...');
		if (this.status && this.status.connected) return this.handle("Already connected.");
		this.closed = false;
		let webSocket = new wsClient();
		this.webSocket = webSocket;
		let client = this;
		client.rooms = {}; //reset
		webSocket.on('connectFailed', function (err) {
				client.emit('disconnect', err);
				client.handle(`Unable to connect to ${client.opts.server}: ${util.inspect(err)}`);
				if (client.opts.autoReconnect) {
					client.debug(`Retrying connection in ${client.opts.autoReconnect / 1000}s.`);
					setTimeout(client.connect.bind(client), client.opts.autoReconnect, true);
				}
		});
		webSocket.on('connect', function (connection) {
			client.debug(`Connected to ${client.opts.server}.`);
			client.status.connected = true;
			client.connection = connection;
			connection.on('error', function (err) {
				client.emit('disconnect', err);
				client.handle(`Connection error: ${util.inspect(err)}`);
				client.connection = null;
				client.status.connected = false;
				if (client.opts.autoReconnect) {
					client.debug(`Retrying connection in ${client.opts.autoReconnect / 1000}s.`);
					setTimeout(client.connect.bind(client), client.opts.autoReconnect, true);
				}
			});
			connection.on('close', function () {
				client.emit('disconnect', null);
				client.debug(`Connection closed: ${util.inspect(arguments)}`);
				client.connection = null;
				client.status.connected = false;
				if (!client.closed && client.opts.autoReconnect) {
					client.debug(`Retrying connection in ${client.opts.autoReconnect / 1000}s.`);
					setTimeout(client.connect.bind(client), client.opts.autoReconnect, true);
				}
			});
			connection.on('message', function (message) {
				if (message.type === 'utf8') {
					client.receive(message.utf8Data);
				}
			});
		});
		let link = `ws://${client.opts.server}:${client.opts.port}/showdown/${100 + ~~(Math.random() * 900)}/${Array.from({ length: 8 }).map(() => 'abcdefghijklmnopqrstuvwxyz0123456789_'[~~(Math.random() * 37)]).join('')}/websocket`;
		webSocket.connect(link);
	}
	disconnect () {
		this.closed = true;
		if (this.connection) this.connection.close();
	}
	login (name, pass) {
		let reqOptions = {
			hostname: this.actionURL.hostname,
			port: this.actionURL.port,
			path: this.actionURL.pathname,
			agent: false
		}
		let data = '';
		if (!pass) {
			reqOptions.method = 'GET';
			reqOptions.path += "?act=getassertion&userid=" + Tools.toID(name) + "&challengekeyid=" + this.challstr.id + "&challenge=" + this.challstr.str;
			this.debug("Sending login request to " + reqOptions.path);
		}
		else {
			reqOptions.method = 'POST';
			data = `act=login&name=${Tools.toID(name)}&pass=${pass}&challengekeyid=${this.challstr.id}&challenge=${this.challstr.str}`;
			reqOptions.headers = {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": data.length
			}
			this.debug(`Shooting login request to ${reqOptions.path} with ${data}`);
		}
		let client = this;
		let req = https.request(reqOptions, function (res) {
			res.setEncoding('utf8');
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', function () {
				if (data === ';') {
					client.handle("Failed to login - incorrect credentials.");
					client.emit('loginFailure', -1);
					return;
				}
				if (data.length < 50) {
					client.handle("Failed to login: " + data);
					if (client.opts.retryLogin) {
						client.debug(`Retrying login in ${client.opts.retryLogin / 1000}s.`);
						setTimeout(client.login.bind(client), client.opts.retryLogin, name, pass);
					}
					client.emit('loginFailure', -2);
					return;
				}
				if (data.includes('heavy load')) {
					client.handle("The login server is under heavy load.");
					client.emit('loginFailure', -3);
					if (client.opts.retryLogin) {
						client.debug(`Retrying login in ${client.opts.retryLogin / 1000}s.`);
						setTimeout(client.login.bind(client), client.opts.retryLogin, name, pass);
					}
					return;
				}
				try {
					data = JSON.parse(data.substr(1));
					if (data.actionsuccess) data = data.assertion;
					else {
						client.handle(`Unable to login: ${JSON.stringify(data)}`);
						client.emit('loginFailure', -4);
						if (client.opts.retryLogin) {
							client.debug(`Retrying login in ${client.opts.retryLogin / 1000}s.`);
							setTimeout(client.login.bind(client), client.opts.retryLogin, name, pass);
						}
						return;
					}
				} catch (e) {}
				client.debug("Sending login trn...");
				client.send(`|/trn ${name},0,${data}`);
			});
		});
		req.on('error', function (err) {
			client.handle(`Login error: ${util.inspect(err)}`);
			client.emit('loginFailure', err);
			if (client.opts.retryLogin) {
				client.debug(`Retrying login in ${client.opts.retryLogin / 1000}s.`);
				setTimeout(client.login.bind(client), client.opts.retryLogin, name, pass);
			}
			return;
		});
		if (data) req.write(data);
		req.end();
	}

	// Sending data
	activateQueue () {
		let client = this, throttle = client.isTrusted ? 300 : 1800;
		client.activatedQueue = true;
		this.queueTimer = setInterval(() => {
			let messages = client.queue.splice(0, 3);
			this.queued.push(...messages.filter(msg => /^(?:[a-z0-9-]+\|[^/]|\|\/pm [^,]+,[^/])/.test(msg.content)));
			this.send(Object.values(messages).map(message => message.content));
		}, throttle);
		return;
	}
	send (text) {
		if (!text.length) return;
		if (!this.connection) return this.handle('Not connected!');
		if (!Array.isArray(text)) text = [text];
		if (text.length > 3) this.handle("The message limit is 3 at a time! Please use Client#sendQueue instead.");
		text = JSON.stringify(text);
		this.connection.send(text);
		return;
	}
	sendQueue (text, sent, fail) {
		if (!this.status.connected) return fail({cause: 'Not connected.', message: text});
		this.queue.push({content: text, sent: sent, fail: fail});
		return;
	}
	sendUser (user, text) {
		let userid;
		if (user instanceof User) userid = user.userid;
		else userid = Tools.toID(user);
		if (!userid) this.handle("Invalid ID in Client#sendUser");
		this.addUser({userid: userid});
		return this.users[userid].send(text);
	}

	// Receiving data
	receive (message) {
		let flag = message.substr(0, 1);
		let data;
		switch (flag) {
			case 'a':
				data = JSON.parse(message.substr(1));
				if (data instanceof Array) {
					for (let i = 0; i < data.length; i++) {
						this.receiveMsg(data[i]);
					}
				} else {
					this.receiveMsg(message);
				}
				break;
		}
	}
	receiveMsg (message) {
		if (!message) return;
		if (message.indexOf('\n') > -1) {
			let spl = message.split('\n');
			let room = 'lobby';
			if (spl[0].charAt(0) === '>') {
				room = spl[0].substr(1);
				if (room === '') room = 'lobby';
			}
			for (let i = 0, len = spl.length; i < len; i++) {
				if (spl[i].split('|')[1] && (spl[i].split('|')[1] === 'init')) {
					for (let j = i; j < len; j++) {
						this.receiveLine(room, spl[j], true);
					}
					break;
				} else {
					this.receiveLine(room, spl[i]);
				}
			}
		} else {
			this.receiveLine('lobby', message);
		}
	}
	receiveLine (room, message, isIntro) {
		this.emit('line', room, message, isIntro);
		let args = message.split('|');
		switch (args[1]) {
			case 'formats': {
				this.emit('formats', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'updateuser': {
				if (!args[2].startsWith(' Guest')) {
					this.debug(`Successfully logged in as ${args[2].substr(1)}.`);
					this.status.loggedIn = true;
					this.emit('loggedin', args[2]);
					this.send('|/ip');
					this.opts.autoJoin.forEach(room => this.send(`|/join ${room}`));
					if (this.opts.avatar) this.send(`|/avatar ${this.opts.avatar}`);
				}
				this.status.username = args[2].substr(1);
				this.emit('updateuser', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'challstr': {
				this.challstr = {
					id: args[2],
					str: args[3]
				}
				if (this.opts.username) this.login(this.opts.username, this.opts.password());
				break;
			}
			case 'init': {
				if (!this.rooms[room]) this.rooms[room] = new Room(room, this);
				this.send(`|/cmd roominfo ${room}`);
				this.emit('joinRoom', room);
				break;
			}
			case 'deinit': {
				if (this.rooms[room]) delete this.rooms[room];
				this.emit('leaveRoom', room);
				break;
			}
			case 'html': {
				if (this.status.loggedIn && typeof this.opts.isTrusted !== 'boolean') {
					if (message.includes("<small style=\"color:gray\">(trusted)</small>")) this.opts.isTrusted = true;
					else this.opts.isTrusted = false;
					if (!this.activatedQueue) this.activateQueue();
				}
				this.emit('html', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'queryresponse': {
				switch (args[2]) {
					case 'roominfo': {
						let roominfo;
						try {
							roominfo = JSON.parse(args.slice(3).join('|'));
						} catch (e) {
							this.handle(`Error in parsing roominfo: ${e.message}`);
						}
						if (!this.rooms[roominfo.roomid]) break;
						Object.keys(roominfo).forEach(key => this.rooms[roominfo.roomid][key] = roominfo[key]);
						roominfo.users.forEach(user => this.getUserDetails(user).catch(this.handle));
						break;
					}
					case 'userdetails': {
						let userdetails;
						try {
							userdetails = JSON.parse(args.slice(3).join('|'));
						} catch (e) {
							this.handle(`Error in parsing userdetails: ${e.message}`);
						}
						this.addUser(userdetails);
						let user;
						for (let u of this.userdetailsQueue) {
							if (u.id === userdetails.id) {
								user = u;
								break;
							}
						}
						if (user) user.resolve(userdetails);
						break;
					}
				}
				this.emit('queryresponse', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'chat': case 'c': {
				// by, text, type, target, raw, isIntro, parent, time
				let by = args[2], value = args.slice(3).join('|'), mssg = new Message({by: by, text: value, type: 'chat', target: room, raw: message, isIntro: isIntro, parent: this}), resolved = [];
					if (mssg.target) {
					mssg.target.waits.forEach(wait => {
						if (wait.condition(mssg)) {
							wait.resolve(mssg);
							resolved.push(wait.id);
						}
					});
					mssg.target.waits = mssg.target.waits.filter(wait => !resolved.includes(wait.id));
					if (by.substr(1) === this.status.username) {
						if (this.queued.map(msg => msg.content).includes(value)) {
							while (this.queued.length) {
								let msg = this.queued.shift();
								if (msg.content === value) {
									msg.sent(mssg);
									break;
								}
								msg.fail(msg.content);
							}
						}
					}
				}
				this.emit('message', mssg);
				break;
			}
			case 'c:': {
				let by = args[3], value = args.slice(4).join('|'), mssg = new Message({by: by, text: value, type: 'chat', target: room, raw: message, isIntro: isIntro, parent: this, time: parseInt(args[2])}), comp = room + '|' + value, resolved = [];
				mssg.target.waits.forEach(wait => {
					if (wait.condition(mssg)) {
						wait.resolve(mssg);
						resolved.push(wait.id);
					}
				});
				mssg.target.waits = mssg.target.waits.filter(wait => !resolved.includes(wait.id));
				if (!isIntro && by.substr(1) === this.status.username && this.queued.map(msg => msg.content).includes(comp)) {
					while (this.queued.length) {
						let msg = this.queued.shift();
						if (msg.content === comp) {
							msg.sent(mssg);
							break;
						}
						msg.fail(msg.content);
					}
				}
				this.emit('message', mssg);
				break;
			}
			case 'pm': {
				let by = args[2], to = args[3], value = args.slice(4).join('|'), chatWith, resolved = [];
				if (by.substr(1) === this.status.username) chatWith = to;
				else chatWith = by;
				let mssg = new Message({by: by, text: value, type: 'pm', target: Tools.toID(chatWith), raw: message, isIntro: isIntro, parent: this, time: Date.now()}), comp = `|/pm ${Tools.toID(to)},${value}`;
				if (mssg.command && mssg.command === 'error') mssg.target.waits.shift().fail(mssg.content.substr(7));
				if (mssg.target) {
					mssg.target.waits.forEach(wait => {
						if (wait.condition(mssg)) {
							wait.resolve(mssg);
							resolved.push(wait.id);
						}
					});
					mssg.target.waits = mssg.target.waits.filter(wait => !resolved.includes(wait.id));
					if (!isIntro && by.substr(1) === this.status.username && this.queued.map(msg => msg.content).includes(comp)) {
						while (this.queued.length) {
							let msg = this.queued.shift();
							if (msg.content === comp) {
								msg.sent(mssg);
								break;
							}
							msg.fail(msg.content);
							if (/^\/error (?:User .*? is offline\.|User .*? not found\. Did you misspell their name\?)$/.test(value)) break;
						}
					}
				} else {
					if (value.startsWith('/raw ') && this.status && this.status.loggedIn && typeof this.opts.isTrusted !== 'boolean') {
						if (value.includes("<small style=\"color:gray\">(trusted)</small>")) this.opts.isTrusted = true;
						else this.opts.isTrusted = false;
						if (!this.activatedQueue) this.activateQueue();
					}
				}
				if (mssg.target) this.emit('message', mssg);
				break;
			}
			case 'j': case 'J': case 'join': {
				this.send(`|/cmd roominfo ${room}`);
				this.addUser({userid: Tools.toID(args.slice(2).join('|'))});
				this.emit('join', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'l': case 'L': case 'leave': {
				this.send(`|/cmd roominfo ${room}`);
				this.emit('leave', room, args.slice(2).join('|'), isIntro);
				break;
			}
			case 'n': case 'N': case 'name': {
				this.send(`|/cmd roominfo ${room}`);
				this.emit('name', room, args[2], args[3]);
				let old = Tools.toID(args[3]), yng = Tools.toID(args[2]);
				if (!this.users[old]) break;
				this.users[old].alts.push(yng);
				this.users[yng] = this.users[old];
				delete this.users[old];
				this.getUserDetails(yng);
				break;
			}
			case 'error': {
				this.emit('chaterror', room, args.slice(2).join('|'), isIntro);
				break;
			}
			default: this.emit(args[1], room, args.slice(2).join('|'), isIntro);
		}
	}

	// Utility
	addUser (input) {
		if (typeof input !== 'object' || !input.userid) throw new Error ("Input must be an object with userid for new User");
		let user = this.users[input.userid];
		if (!user) {
			this.users[input.userid] = new User (input, this);
			user = this.users[input.userid];
			this.getUserDetails(input.userid);
		}
		Object.keys(input).forEach(key => user[key] = input[key]);
		return user;
	}
	getUser (str) {
		if (str instanceof User) str = str.userid;
		if (typeof str !== 'string') return null;
		str = Tools.toID(str);
		if (this.users[str]) return this.users[str];
		for (let user of this.users) {
			if (user.alts.includes(str)) return user;
		}
		return false;
	}
	getUserDetails (userid) {
		userid = Tools.toID(userid);
		let client = this;
		return new Promise (resolve => {
			this.send(`|/cmd userdetails ${userid}`);
			client.userdetailsQueue.push({id: userid, resolve: resolve});
		});
	}
}


Data.abilities = require('./showdown/abilities.js').BattleAbilities;
Data.aliases = require('./showdown/aliases.js').BattleAliases;
Data.config = require('./showdown/config.js').Config;
Data.formatsData = require('./showdown/formats-data.js').BattleFormatsData;
Data.formats = require('./showdown/formats.js').Formats;
Data.items = require('./showdown/items.js').BattleItems;
Data.learnsets = require('./showdown/learnsets.js').BattleLearnsets;
Data.moves = require('./showdown/moves.js').BatleMovedex;
Data.pokedex = require('./showdown/pokedex.js').BattlePokedex;
Data.typechart = require('./showdown/typechart.js').BattleTypeChart;


module.exports = {
	Client: Client,
	classes: {
		Message: Message,
		User: User,
		Room: Room
	},
	Tools: Tools,
	Data: Data
}