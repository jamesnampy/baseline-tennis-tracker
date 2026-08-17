export default function Home() {
  return (
    <main className="phone-shell">
      <header className="match-bar">
        <button aria-label="Close match">×</button>
        <div><span>SET 1 · LIVE</span><strong>Ethan vs. Noah</strong></div>
        <button className="undo" aria-label="Undo last action">↶<small>Undo</small></button>
      </header>
      <section className="score-card" aria-label="Current score">
        <div className="player serving"><i /> Ethan</div><b>3</b><strong>30</strong>
        <div className="player">Noah</div><b>2</b><strong>15</strong>
      </section>
      <section className="prompt">
        <p>POINT 42 · ETHAN SERVING</p>
        <h1>First serve</h1>
      </section>
      <section className="serve-actions">
        <button className="serve-in"><small>1ST SERVE</small><strong>In</strong><span>Continue point</span></button>
        <button className="fault"><small>1ST SERVE</small><strong>Fault</strong><span>Second serve</span></button>
        <button className="ace"><small>POINT WON</small><strong>Ace</strong><span>Finish point</span></button>
      </section>
      <button className="mental-pill"><span>●</span> Ethan is focused <b>Change</b></button>
      <nav><button className="active">●<span>Track</span></button><button>▥<span>Stats</span></button><button>◇<span>Match</span></button></nav>
    </main>
  );
}
