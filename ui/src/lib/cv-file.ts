/** Read supported CV files locally in the browser. Nothing is uploaded. */

const PLAIN = /\.(md|markdown|txt|text|rtf)$/iu;
const WORD = /\.docx$/iu;
const LEGACY_WORD = /\.doc$/iu;
const MAX_PLAIN_BYTES = 512 * 1024;
const MAX_DOCX_BYTES = 8 * 1024 * 1024;

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([^A-Za-z0-9\s])/gu, '$1');
}

export async function readCvFile(file: File): Promise<string> {
  if (PLAIN.test(file.name)) {
    if (file.size > MAX_PLAIN_BYTES) {
      throw new Error('That text file is over 512 KB. Choose the CV itself rather than a larger notes file.');
    }
    return readTextFile(file);
  }

  if (WORD.test(file.name)) {
    if (file.size > MAX_DOCX_BYTES) {
      throw new Error('That Word file is over 8 MB. Save a copy without large images, then try again.');
    }
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToMarkdown({ arrayBuffer: await file.arrayBuffer() });
    return unescapeMarkdown(value);
  }

  throw new Error(
    LEGACY_WORD.test(file.name)
      ? 'That is an older Word format. Open it in Word and save it as .docx, then try again.'
      : 'Choose a Word (.docx), Markdown or text file. For a PDF, export the original as Word or paste its text so the layout is not misread.',
  );
}

export const CV_FILE_ACCEPT = '.docx,.md,.markdown,.txt,.text,.rtf';
