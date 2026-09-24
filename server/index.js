'use strict';
const http = require('http');
const { createApp } = require('./app');
const sockets = require('./sockets');
const bus = require('./lib/bus');
const { appConfig } = require('./lib/config');

const cfg = appConfig();
const PORT = Number(process.env.PORT || cfg.socket_port || 3000);

const app = createApp();
const server = http.createServer(app);

const io = sockets.attach(server);
bus.setIo(io);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Black Meet (node) listening on :' + PORT);
});