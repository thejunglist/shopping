// Barcode reading for the scan screen.
//
// Chrome on Android has a barcode reader built in. iPhone Safari does not, so
// there the app loads a small WebAssembly reader (ZXing) instead. Both are used
// through the same `detect(video)` call.
//
// The WebAssembly file is bundled with the app and served from this server. The
// library's default is to fetch it from a public CDN, which would make
// scanning depend on a third party. `zxing-wasm` is a direct dependency pinned
// to the exact version `barcode-detector` uses, so the file always matches the
// JavaScript that loads it: bump the two together.

// UK groceries carry EAN-13, EAN-8 or UPC-A barcodes.
const FORMATS = ['ean_13', 'ean_8', 'upc_a'];

let loading;

/** Resolves to { detector, native }. Loaded once, on the first scan. */
export function getDetector() {
  loading ??= create().catch((error) => {
    loading = undefined; // allow a retry, for example after a dropped connection
    throw error;
  });
  return loading;
}

async function create() {
  const Native = globalThis.BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (FORMATS.every((format) => supported.includes(format))) {
        return { detector: new Native({ formats: FORMATS }), native: true };
      }
    } catch {
      // fall through to the bundled reader
    }
  }

  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
  });
  return { detector: new BarcodeDetector({ formats: FORMATS }), native: false };
}
