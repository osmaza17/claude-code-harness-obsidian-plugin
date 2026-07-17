// Minimal stand-ins for the "obsidian" module so pure plugin code (exporter.ts
// etc.) can be imported from plain Node in tests. Only what those modules
// actually import at runtime needs to exist.
export const moment = () => ({ format: () => "test", fromNow: () => "test" });
export class Notice {}
export class TFile {}
export const setIcon = () => {};
