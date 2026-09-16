// assets/js/live.js — one shared, always-on realtime connection for every page.
// Provides a tiny pub/sub so any page can react instantly to server events
// without refreshing. Falls back to polling only if the socket cannot connect.
(function () {
  'use strict';
  var handlers = {};   // event -> [fn]
  var socket = null;
  var started = false;
  var joined = {};     // roomName -> true

  function on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    if (socket && socket.connected) bindOne(ev);
    return function off() {
      handlers[ev] = (handlers[ev] || []).filter(function (f) { return f !== fn; });
    };
  }
  function emitLocal(ev, data) {
    (handlers[ev] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { /* keep other handlers alive */ }
    });
  }

  // Re-bind page handlers to the socket after every (re)connect.
  function bindAll() {
    if (!socket) return;
    Object.keys(handlers).forEach(bindOne);
  }
  function bindOne(ev) {
    socket.off('bm:' + ev); // avoid duplicate bindings after reconnects
    socket.on('bm:' + ev, function (data) { emitLocal(ev, data); });
  }

  function connect() {
    if (window.__BM_LIVE_URL === null) return;      // page opted out entirely
    var url = window.__BM_LIVE_URL || undefined;    // '' → same origin (proxied)
    socket = io(url, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 15000
    });
    window.BM_SOCKET = socket;
    socket.on('connect', function () {
      emitLocal('live:connected', true);
      bindAll();
      // re-join any rooms this page asked for (survives reconnects)
      Object.keys(joined).forEach(function (room) { socket.emit('bm:subscribe', { room: room }); });
    });
    socket.on('disconnect', function () { emitLocal('live:disconnected', true); });
  }

  // Join a broadcast room (e.g. 'announcements', 'meeting-<id>')
  function subscribe(room) {
    if (!room) return;
    joined[room] = true;
    if (socket && socket.connected) socket.emit('bm:subscribe', { room: room });
  }

  window.BMLive = {
    on: on,
    subscribe: subscribe,
    socket: function () { return socket; },
    isLive: function () { return !!(socket && socket.connected); }
  };

  function start() {
    if (started) return;
    started = true;
    if (typeof io === 'undefined') {
      // socket.io script failed to load (e.g. offline) — retry quietly
      setTimeout(start, 5000);
      return;
    }
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
