/**
 * Stockfish Web Worker
 *
 * Loads Stockfish WASM and provides UCI interface.
 */

let stockfish = null;

// Load Stockfish from local vendor (offline-first)
const STOCKFISH_URLS = [
    '/static/vendor/js/stockfish.js',
];

async function initEngine() {
    for (const url of STOCKFISH_URLS) {
        try {
            importScripts(url);
            if (typeof Stockfish === 'function') {
                stockfish = Stockfish();
                stockfish.addMessageListener((line) => {
                    postMessage(line);
                });
                postMessage('info string Stockfish loaded');
                return true;
            }
        } catch (e) {
            console.error('Failed to load from:', url, e);
        }
    }
    postMessage('info string Stockfish failed to load - using fallback');
    return false;
}

initEngine();

// Receive commands from main thread
onmessage = (e) => {
    if (stockfish) {
        stockfish.postMessage(e.data);
    }
};
