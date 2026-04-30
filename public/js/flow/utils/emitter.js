export default function EventEmitter(obj) {
  if (!obj) return
  obj._events = obj._events || {}

  obj.on = function (event, listener) {
    if (!this._events[event]) this._events[event] = []
    this._events[event].push(listener)
    return this
  }

  obj.off = function (event, listener) {
    if (!this._events[event]) return this
    if (!listener) {
      delete this._events[event]
      return this
    }
    this._events[event] = this._events[event].filter((l) => l !== listener)
    return this
  }

  obj.once = function (event, listener) {
    const onceListener = (...args) => {
      this.off(event, onceListener)
      listener.apply(this, args)
    }
    this.on(event, onceListener)
    return this
  }

  obj.emit = function (event, ...args) {
    const listeners = this._events[event]
    if (!listeners || !listeners.length) return this
    listeners.slice().forEach((listener) => listener.apply(this, args))
    return this
  }

  return obj
}
