// Empty stub — canvas is not available in the browser bundle.
// pdfmake and other packages check for canvas at runtime; this prevents
// Turbopack from trying to resolve the native node canvas module.
export default undefined;
