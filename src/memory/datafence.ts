// Untrusted text quoted INTO a memory entry as data: the fence is the review
// core's (src/datafence.ts, which says how it works); the memory writers and
// readers import it here.
export {
  cleanQuotedText,
  FEEDBACK_FULL_TEXT_LABEL,
  fenceAsData,
  readFencedData,
} from "../datafence.js";
