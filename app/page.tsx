import { BODY_HTML } from './_markup';

export default function Page() {
  return <div dangerouslySetInnerHTML={{ __html: BODY_HTML }} />;
}
