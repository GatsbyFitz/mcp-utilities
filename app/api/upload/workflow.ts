import { IngestInput, recordUpload } from "./steps/recordUpload";
import { uploadPdf } from "./steps/uploadFile";
import { createMarkdown } from "./steps/pdfReader";
import { createEmbeddings } from "./steps/createEmbeddings";




export async function ingestPdf(input: IngestInput) {
  "use workflow";

  const blob = await uploadPdf(input.fileName, input.data);
  const markdown = await createMarkdown(blob.url);
  const { chunkCount, title } = await createEmbeddings(input.fileName, blob, markdown);
  
  await recordUpload(input, blob, chunkCount);

  return { fileName: input.fileName, chunks: chunkCount, title };
}


    
