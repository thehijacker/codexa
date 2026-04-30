/**
 * Creates a Path object for parsing and manipulation of a path string
 * @param {string} pathString a url string (relative or absolute)
 * @class
 */
class Path {
  constructor(pathString) {
    let parsed
    const protocol = pathString.indexOf('://')
    if (protocol > -1) {
      pathString = new URL(pathString).pathname
    }

    parsed = this.parse(pathString)

    this.path = pathString

    if (this.isDirectory(pathString)) {
      this.directory = pathString
    } else {
      this.directory = parsed.dir + '/'
    }

    this.filename = parsed.base
    this.extension = parsed.ext.slice(1)
  }

  parse(what) {
    const path = String(what || '')
    const normalize = (p) => p.replace(/\\/g, '/')
    const normalized = normalize(path)
    const isDir = normalized.endsWith('/')
    const parts = normalized.split('/')
    const base = parts[parts.length - 1] || ''
    const dir = isDir ? normalized : parts.slice(0, -1).join('/')
    const extMatch = base.match(/(\.[^.]+)$/)
    const ext = extMatch ? extMatch[1] : ''
    const name = base.replace(/\.[^.]+$/, '')

    return {
      root: normalized.startsWith('/') ? '/' : '',
      dir: dir || (normalized.startsWith('/') ? '/' : ''),
      base,
      ext,
      name,
    }
  }

  isAbsolute(what) {
    const target = what || this.path
    return target.startsWith('/') || /^[a-zA-Z]+:\\/ .test(target)
  }

  isDirectory(what) {
    return String(what || this.path).slice(-1) === '/'
  }

  resolve(what) {
    if (!what) return this.directory
    if (this.isAbsolute(what) || what.indexOf('://') > -1) {
      return what
    }

    const parts = (this.directory + what).split('/')
    const result = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (result.length && result[result.length - 1] !== '..') {
          result.pop()
        } else {
          result.push('..')
        }
      } else {
        result.push(part)
      }
    }
    return (this.directory.startsWith('/') ? '/' : '') + result.join('/')
  }

  relative(what) {
    if (!what) return ''
    if (what.indexOf('://') > -1) return what
    const from = this.directory.replace(/\/\/$/, '')
    const to = String(what)
    const fromParts = from.split('/')
    const toParts = to.split('/')
    while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
      fromParts.shift()
      toParts.shift()
    }
    const upSteps = Math.max(0, fromParts.length - 1)
    return [...Array(upSteps).fill('..'), ...toParts].join('/')
  }

  toString() {
    return this.path
  }
}

export default Path
