export default function Home() {
  return (
    <main>
      <section className="card">
        <p className="eyebrow">GITUBGEN INFRASTRUCTURE</p>
        <h1>Status Recorder</h1>
        <p>
          Service ini merekam perubahan Status GitHub Project V2 secara mandiri ketika
          timeline activity GitHub tidak tersedia.
        </p>
        <div className="status"><span /> Recorder API ready</div>
        <ul>
          <li><code>GET /api/health</code> — health check</li>
          <li><code>GET /api/record-status</code> — protected cron endpoint</li>
          <li><code>POST /api/status-history</code> — protected history endpoint</li>
        </ul>
      </section>
    </main>
  );
}
