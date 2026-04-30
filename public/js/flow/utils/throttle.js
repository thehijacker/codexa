export default function throttle(fn, wait) {
  let last = 0
  let timeout
  return function (...args) {
    const now = Date.now()
    const remaining = wait - (now - last)
    if (remaining <= 0) {
      clearTimeout(timeout)
      timeout = undefined
      last = now
      fn.apply(this, args)
    } else if (!timeout) {
      timeout = setTimeout(() => {
        last = Date.now()
        timeout = undefined
        fn.apply(this, args)
      }, remaining)
    }
  }
}
