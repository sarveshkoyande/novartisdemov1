export default function Signature({ agent = 'Requirement Collection Agent' }: { agent?: string }) {
  return <div className="upload-signature"><span aria-hidden="true" />NORA <span aria-hidden="true">/</span> {agent}</div>;
}
