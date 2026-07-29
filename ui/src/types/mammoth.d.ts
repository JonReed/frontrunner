/**
 * Minimal declaration for mammoth, which ships no types.
 *
 * Only the one function this project calls is declared. A fuller stub would be
 * guesswork about an API we do not use, and guesswork that typechecks is worse
 * than no types at all.
 */
declare module 'mammoth' {
  export interface ConvertResult {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function convertToMarkdown(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
}
