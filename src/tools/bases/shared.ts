import { escapeControlChars } from "../../lib/errors.js";

/** Escape control characters before embedding values in Base tool display text. */
export const displayBaseValue = escapeControlChars;
