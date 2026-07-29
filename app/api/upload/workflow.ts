import { IngestInput, recordUpload } from "./steps/recordUpload";
import { uploadPdf, uploadMarkdown } from "./steps/uploadFile";
import { createMarkdown } from "./steps/pdfReader";
import { createEmbeddings } from "./steps/createEmbeddings";
import { extractGraph } from "./steps/extractGraph";




export async function ingestPdf(input: IngestInput) {
  "use workflow";

  const blob = await uploadPdf(input.fileName, input.data);
  const markdown = await createMarkdown(blob.url);

  // Persisted so a future re-embed can skip the Gemini PDF→Markdown step
  // entirely instead of re-parsing the PDF from scratch every time.
  const markdownUrl = await uploadMarkdown(input.fileName, markdown);

  const { chunkCount, title } = await createEmbeddings(input.fileName, blob, markdown);

  // Separate step from createEmbeddings: extraction is the expensive, flaky
  // part, and a retry here shouldn't re-embed every chunk. It re-derives
  // chunks from the markdown rather than receiving them, so the workflow
  // doesn't have to durably persist the whole document twice.
  const { entityCount, relationCount } = await extractGraph(input.fileName, markdown);

  await recordUpload(input, blob, chunkCount, markdownUrl);

  return {
    fileName: input.fileName,
    chunks: chunkCount,
    title,
    entities: entityCount,
    relations: relationCount,
  };
}


    
