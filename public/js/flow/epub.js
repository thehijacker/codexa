import Book from './book.js'
import Contents from './contents.js'
import CFI from './epubcfi.js'
import ContinuousViewManager from './managers/continuous/index.js'
import DefaultViewManager from './managers/default/index.js'
import IframeView from './managers/views/iframe.js'
import Rendition from './rendition.js'
import { EPUBJS_VERSION } from './utils/constants.js'
import * as utils from './utils/core.js'

/**
 * Creates a new Book
 * @param {string|ArrayBuffer} url URL, Path or ArrayBuffer
 * @param {object} options to pass to the book
 * @returns {Book} a new Book object
 * @example ePub("/path/to/book.epub", {})
 */
function ePub(url, options) {
  return new Book(url, options)
}

ePub.VERSION = EPUBJS_VERSION

if (typeof global !== 'undefined') {
  global.EPUBJS_VERSION = EPUBJS_VERSION
}

ePub.Book = Book
ePub.Rendition = Rendition
ePub.Contents = Contents
ePub.CFI = CFI
ePub.utils = utils

export default ePub
