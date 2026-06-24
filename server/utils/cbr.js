// CBR (Comic Book RAR) utilities.
// Requires: npm install node-unrar-js

const AdmZip = require('adm-zip');

const RAR4_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_SIG = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;

function isCbrBuffer(buf) {
  if (!buf || buf.length < 7) return false;
  return buf.slice(0, 7).equals(RAR4_SIG) || buf.slice(0, 8).equals(RAR5_SIG);
}

// Extract all image files from a RAR buffer and repack as a ZIP (CBZ) buffer.
async function convertCbrToCbz(rarBuffer) {
  let createExtractorFromData;
  try {
    ({ createExtractorFromData } = require('node-unrar-js'));
  } catch {
    throw new Error('CBR support requires node-unrar-js — run: npm install node-unrar-js');
  }

  const extractor = await createExtractorFromData({ data: rarBuffer });
  const { files } = extractor.extract();

  const zip = new AdmZip();
  let count = 0;
  for (const file of files) {
    if (file.fileHeader.flags.directory) continue;
    if (!IMAGE_EXT.test(file.fileHeader.name)) continue;
    zip.addFile(file.fileHeader.name, Buffer.from(file.extraction));
    count++;
  }
  if (count === 0) throw new Error('[cbr] no images found in RAR archive');
  console.log(`[cbr] converted ${count} images CBR → CBZ`);
  return zip.toBuffer();
}

module.exports = { isCbrBuffer, convertCbrToCbz };
