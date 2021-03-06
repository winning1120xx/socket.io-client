import { Packet, PacketType } from "socket.io-parser";
import Emitter = require("component-emitter");
import { on } from "./on";
import * as bind from "component-bind";
import { Manager } from "./manager";

const debug = require("debug")("socket.io-client:socket");

export interface SocketOptions {
  /**
   * the authentication payload sent when connecting to the Namespace
   */
  auth: object | ((cb: (data: object) => void) => void);
}

/**
 * Internal events.
 * These events can't be emitted by the user.
 */

const RESERVED_EVENTS = {
  connect: 1,
  connect_error: 1,
  disconnect: 1,
  disconnecting: 1,
  // EventEmitter reserved events: https://nodejs.org/api/events.html#events_event_newlistener
  newListener: 1,
  removeListener: 1,
};

interface Flags {
  compress?: boolean;
  volatile?: boolean;
}

export class Socket extends Emitter {
  public readonly io: Manager;

  public id: string;
  public connected: boolean;
  public disconnected: boolean;

  private readonly nsp: string;
  private readonly auth: object | ((cb: (data: object) => void) => void);

  private ids: number = 0;
  private acks: object = {};
  private receiveBuffer: Array<any> = [];
  private sendBuffer: Array<any> = [];
  private flags: Flags = {};
  private subs: Array<any>;
  private _anyListeners: Array<(...args: any[]) => void>;

  /**
   * `Socket` constructor.
   *
   * @public
   */
  constructor(io: Manager, nsp: string, opts?: Partial<SocketOptions>) {
    super();
    this.io = io;
    this.nsp = nsp;
    this.ids = 0;
    this.acks = {};
    this.receiveBuffer = [];
    this.sendBuffer = [];
    this.connected = false;
    this.disconnected = true;
    this.flags = {};
    if (opts && opts.auth) {
      this.auth = opts.auth;
    }
    if (this.io._autoConnect) this.open();
  }

  /**
   * Subscribe to open, close and packet events
   *
   * @private
   */
  private subEvents() {
    if (this.subs) return;

    const io = this.io;
    this.subs = [
      on(io, "open", bind(this, "onopen")),
      on(io, "packet", bind(this, "onpacket")),
      on(io, "close", bind(this, "onclose")),
    ];
  }

  /**
   * "Opens" the socket.
   *
   * @public
   */
  public connect(): Socket {
    if (this.connected) return this;

    this.subEvents();
    if (!this.io._reconnecting) this.io.open(); // ensure open
    if ("open" === this.io._readyState) this.onopen();
    return this;
  }

  /**
   * Alias for connect()
   */
  public open(): Socket {
    return this.connect();
  }

  /**
   * Sends a `message` event.
   *
   * @return {Socket} self
   * @public
   */
  public send(...args: any[]) {
    args.unshift("message");
    this.emit.apply(this, args);
    return this;
  }

  /**
   * Override `emit`.
   * If the event is in `events`, it's emitted normally.
   *
   * @param {String} ev - event name
   * @return {Socket} self
   * @public
   */
  public emit(ev: string, ...args: any[]) {
    if (RESERVED_EVENTS.hasOwnProperty(ev)) {
      throw new Error('"' + ev + '" is a reserved event name');
    }

    args.unshift(ev);
    const packet: any = {
      type: PacketType.EVENT,
      data: args,
    };

    packet.options = {};
    packet.options.compress = this.flags.compress !== false;

    // event ack callback
    if ("function" === typeof args[args.length - 1]) {
      debug("emitting packet with ack id %d", this.ids);
      this.acks[this.ids] = args.pop();
      packet.id = this.ids++;
    }

    const isTransportWritable =
      this.io.engine &&
      this.io.engine.transport &&
      this.io.engine.transport.writable;

    const discardPacket =
      this.flags.volatile && (!isTransportWritable || !this.connected);
    if (discardPacket) {
      debug("discard packet as the transport is not currently writable");
    } else if (this.connected) {
      this.packet(packet);
    } else {
      this.sendBuffer.push(packet);
    }

    this.flags = {};

    return this;
  }

  /**
   * Sends a packet.
   *
   * @param {Object} packet
   * @private
   */
  private packet(packet: Partial<Packet>) {
    packet.nsp = this.nsp;
    this.io._packet(packet);
  }

  /**
   * Called upon engine `open`.
   *
   * @private
   */
  private onopen() {
    debug("transport is open - connecting");
    if (typeof this.auth == "function") {
      this.auth((data) => {
        this.packet({ type: PacketType.CONNECT, data });
      });
    } else {
      this.packet({ type: PacketType.CONNECT, data: this.auth });
    }
  }

  /**
   * Called upon engine `close`.
   *
   * @param {String} reason
   * @private
   */
  private onclose(reason) {
    debug("close (%s)", reason);
    this.connected = false;
    this.disconnected = true;
    delete this.id;
    super.emit("disconnect", reason);
  }

  /**
   * Called with socket packet.
   *
   * @param {Object} packet
   * @private
   */
  private onpacket(packet) {
    const sameNamespace = packet.nsp === this.nsp;

    if (!sameNamespace) return;

    switch (packet.type) {
      case PacketType.CONNECT:
        const id = packet.data.sid;
        this.onconnect(id);
        break;

      case PacketType.EVENT:
        this.onevent(packet);
        break;

      case PacketType.BINARY_EVENT:
        this.onevent(packet);
        break;

      case PacketType.ACK:
        this.onack(packet);
        break;

      case PacketType.BINARY_ACK:
        this.onack(packet);
        break;

      case PacketType.DISCONNECT:
        this.ondisconnect();
        break;

      case PacketType.CONNECT_ERROR:
        super.emit("connect_error", packet.data);
        break;
    }
  }

  /**
   * Called upon a server event.
   *
   * @param {Object} packet
   * @private
   */
  private onevent(packet) {
    const args = packet.data || [];
    debug("emitting event %j", args);

    if (null != packet.id) {
      debug("attaching ack callback to event");
      args.push(this.ack(packet.id));
    }

    if (this.connected) {
      this.emitEvent(args);
    } else {
      this.receiveBuffer.push(args);
    }
  }

  private emitEvent(args) {
    if (this._anyListeners && this._anyListeners.length) {
      const listeners = this._anyListeners.slice();
      for (const listener of listeners) {
        listener.apply(this, args);
      }
    }
    super.emit.apply(this, args);
  }

  /**
   * Produces an ack callback to emit with an event.
   *
   * @private
   */
  private ack(id) {
    const self = this;
    let sent = false;
    return function (...args: any[]) {
      // prevent double callbacks
      if (sent) return;
      sent = true;
      debug("sending ack %j", args);

      self.packet({
        type: PacketType.ACK,
        id: id,
        data: args,
      });
    };
  }

  /**
   * Called upon a server acknowlegement.
   *
   * @param {Object} packet
   * @private
   */
  private onack(packet) {
    const ack = this.acks[packet.id];
    if ("function" === typeof ack) {
      debug("calling ack %s with %j", packet.id, packet.data);
      ack.apply(this, packet.data);
      delete this.acks[packet.id];
    } else {
      debug("bad ack %s", packet.id);
    }
  }

  /**
   * Called upon server connect.
   *
   * @private
   */
  private onconnect(id: string) {
    this.id = id;
    this.connected = true;
    this.disconnected = false;
    super.emit("connect");
    this.emitBuffered();
  }

  /**
   * Emit buffered events (received and emitted).
   *
   * @private
   */
  private emitBuffered() {
    for (let i = 0; i < this.receiveBuffer.length; i++) {
      this.emitEvent(this.receiveBuffer[i]);
    }
    this.receiveBuffer = [];

    for (let i = 0; i < this.sendBuffer.length; i++) {
      this.packet(this.sendBuffer[i]);
    }
    this.sendBuffer = [];
  }

  /**
   * Called upon server disconnect.
   *
   * @private
   */
  private ondisconnect() {
    debug("server disconnect (%s)", this.nsp);
    this.destroy();
    this.onclose("io server disconnect");
  }

  /**
   * Called upon forced client/server side disconnections,
   * this method ensures the manager stops tracking us and
   * that reconnections don't get triggered for this.
   *
   * @private
   */
  private destroy() {
    if (this.subs) {
      // clean subscriptions to avoid reconnections
      for (let i = 0; i < this.subs.length; i++) {
        this.subs[i].destroy();
      }
      this.subs = null;
    }

    this.io._destroy(this);
  }

  /**
   * Disconnects the socket manually.
   *
   * @return {Socket} self
   * @public
   */
  public disconnect(): Socket {
    if (this.connected) {
      debug("performing disconnect (%s)", this.nsp);
      this.packet({ type: PacketType.DISCONNECT });
    }

    // remove socket from pool
    this.destroy();

    if (this.connected) {
      // fire events
      this.onclose("io client disconnect");
    }
    return this;
  }

  /**
   * Alias for disconnect()
   *
   * @return {Socket} self
   * @public
   */
  public close(): Socket {
    return this.disconnect();
  }

  /**
   * Sets the compress flag.
   *
   * @param {Boolean} compress - if `true`, compresses the sending data
   * @return {Socket} self
   * @public
   */
  public compress(compress: boolean) {
    this.flags.compress = compress;
    return this;
  }

  /**
   * Sets a modifier for a subsequent event emission that the event message will be dropped when this socket is not
   * ready to send messages.
   *
   * @returns {Socket} self
   * @public
   */
  public get volatile(): Socket {
    this.flags.volatile = true;
    return this;
  }

  /**
   * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
   * callback.
   *
   * @param listener
   * @public
   */
  public onAny(listener: (...args: any[]) => void): Socket {
    this._anyListeners = this._anyListeners || [];
    this._anyListeners.push(listener);
    return this;
  }

  /**
   * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
   * callback. The listener is added to the beginning of the listeners array.
   *
   * @param listener
   * @public
   */
  public prependAny(listener: (...args: any[]) => void): Socket {
    this._anyListeners = this._anyListeners || [];
    this._anyListeners.unshift(listener);
    return this;
  }

  /**
   * Removes the listener that will be fired when any event is emitted.
   *
   * @param listener
   * @public
   */
  public offAny(listener?: (...args: any[]) => void): Socket {
    if (!this._anyListeners) {
      return this;
    }
    if (listener) {
      const listeners = this._anyListeners;
      for (let i = 0; i < listeners.length; i++) {
        if (listener === listeners[i]) {
          listeners.splice(i, 1);
          return this;
        }
      }
    } else {
      this._anyListeners = [];
    }
    return this;
  }

  /**
   * Returns an array of listeners that are listening for any event that is specified. This array can be manipulated,
   * e.g. to remove listeners.
   *
   * @public
   */
  public listenersAny() {
    return this._anyListeners || [];
  }
}
