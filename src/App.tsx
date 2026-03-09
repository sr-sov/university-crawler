import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Search,
  Database,
  Split,
  FileText,
  AlertTriangle,
  ServerCrash,
  CheckCircle2,
  Cpu,
  RefreshCw,
  ExternalLink
} from 'lucide-react';

export default function App() {
  const [pipelineState, setPipelineState] = useState<'idle' | 'running' | 'completed' | 'error'>('idle');
  const [currentStep, setCurrentStep] = useState(0);
  const [activeTab, setActiveTab] = useState<'structured' | 'diff' | 'raw'>('structured');
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [runContext, setRunContext] = useState({ targetCount: 0, fieldCount: 0, pairCount: 0 });
  const [livePhase, setLivePhase] = useState("Idle");

  // Input Settings
  const [canonicalUrl, setCanonicalUrl] = useState("http://localhost:4000/api/admissions");
  const [targetUrls, setTargetUrls] = useState(
    [
      "https://www.upou.edu.ph/about/office-of-the-chancellor/",
      "https://registrar.upou.edu.ph/admission/",
      "https://registrar.upou.edu.ph/bachelors-program/",
      "https://our.upou.edu.ph/oas"
    ].join("\n")
  );
  const [fields, setFields] = useState(
    [
      "Chancellor",
      "Vice Chancellor for Academic Affairs",
      "Vice Chancellor for Finance and Administration",
      "Hard copies of admission documents by mail",
      "UgAT requirement",
      "UPCAT requirement",
      "Tuition per unit",
      "Application fee (Filipino undergraduate)",
      "Application fee (Foreign undergraduate)",
      "Admission inquiries email",
      "Technical support email",
      "Mailing address",
      "1st Trimester AY 2026-2027 deadline"
    ].join("\n")
  );

  // Output State
  const [contractResults, setContractResults] = useState<any[]>([]);
  const [uiResults, setUiResults] = useState<any[]>([]);
  const [rawDataResult, setRawDataResult] = useState<any[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [engineUsed, setEngineUsed] = useState("");
  const [savedScanPath, setSavedScanPath] = useState("");
  const [canonicalSelected, setCanonicalSelected] = useState("");
  const [canonicalDatasets, setCanonicalDatasets] = useState<any>(null);
  const [scanStats, setScanStats] = useState<any>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [aiHealth, setAiHealth] = useState<any>(null);

  const engineLabel = (engine: string) => {
    if (!engine) return "Unknown";
    if (engine === 'Anthropic_Claude') return 'Claude AI';
    if (engine.startsWith('Ollama_')) return `Ollama (${engine.replace('Ollama_', '')})`;
    if (engine === 'Deterministic_ClaimsFlat') return 'Deterministic (Claims + Flat)';
    if (engine === 'Local_Regex_Heuristic_Fallback') return 'Local Heuristics (Fallback)';
    if (engine === 'Local_Regex_Heuristic') return 'Local Heuristics';
    return engine;
  };

  const loadHealth = async () => {
    setHealthLoading(true);
    setHealthError("");
    try {
      const resp = await fetch('http://localhost:3000/api/health');
      const data = await resp.json();
      if (!resp.ok) {
        setHealthError(data.error || 'Failed to load AI health.');
        return;
      }
      setAiHealth(data);
    } catch (err: any) {
      setHealthError("Cannot reach backend health endpoint on port 3000.");
      console.error(err);
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    loadHealth();
  }, []);

  const parseListInput = (input: string) =>
    String(input || "")
      .split(/[\n,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

  const startScan = async () => {
    if (!canonicalUrl || !targetUrls) return;
    setPipelineState('running');
    setCurrentStep(0);
    setLogs(["Initializing verification pipeline..."]);
    setElapsedSeconds(0);
    setLivePhase("Preparing request payload");
    setErrorMsg("");
    setEngineUsed("");
    setSavedScanPath("");
    setContractResults([]);
    setUiResults([]);
    setCanonicalSelected("");
    setCanonicalDatasets(null);
    setScanStats(null);

    // Convert strings to array format for backend
    const urlsArray = parseListInput(targetUrls);
    const fieldsArray = parseListInput(fields);
    const pairCount = urlsArray.length * fieldsArray.length;
    setRunContext({
      targetCount: urlsArray.length,
      fieldCount: fieldsArray.length,
      pairCount
    });

    const startedAt = Date.now();
    let lastPhaseIdx = -1;
    let lastHeartbeatSecond = -30;
    const phaseTimeline = [
      { at: 0, step: 0, label: 'Bootstrapping request', message: `Run initialized for ${urlsArray.length} target URL(s), ${fieldsArray.length} watched field(s), ${pairCount} total check units.` },
      { at: 3, step: 1, label: 'Crawling canonical and target URLs', message: 'Fetching canonical base and crawling target pages for snippet extraction.' },
      { at: 10, step: 2, label: 'Building canonical candidates', message: 'Resolving claims and flat canonical references per watched field.' },
      { at: 18, step: 3, label: 'Running field-by-field adjudication', message: 'Applying deterministic checks, then Ollama semantic adjudication when needed.' }
    ];
    const progressInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setElapsedSeconds(elapsed);

      let phaseIdx = 0;
      for (let i = phaseTimeline.length - 1; i >= 0; i -= 1) {
        if (elapsed >= phaseTimeline[i].at) {
          phaseIdx = i;
          break;
        }
      }

      const phase = phaseTimeline[phaseIdx];
      setCurrentStep(phase.step);
      setLivePhase(phase.label);

      if (phaseIdx !== lastPhaseIdx) {
        lastPhaseIdx = phaseIdx;
        const ts = new Date().toISOString().split('T')[1].slice(0, 8);
        setLogs(prev => [...prev, `[${ts}] ${phase.message}`]);
      }

      if (elapsed - lastHeartbeatSecond >= 30) {
        lastHeartbeatSecond = elapsed;
        const ts = new Date().toISOString().split('T')[1].slice(0, 8);
        setLogs(prev => [
          ...prev,
          `[${ts}] Still running. Completed stages may pause while waiting for model output. Elapsed ${elapsed}s.`
        ]);
      }
    }, 1000);

    try {
      const resp = await fetch('http://localhost:3000/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canonicalUrl: canonicalUrl.trim(),
          targetUrls: urlsArray,
          fields: fieldsArray
        })
      });

      clearInterval(progressInterval);
      const data = await resp.json();

      if (!resp.ok) {
        setPipelineState('error');
        setErrorMsg(data.error || "Failed to scan data from server.");
        return;
      }

      setContractResults(Array.isArray(data.results) ? data.results : []);
      setUiResults(Array.isArray(data.ui_results) ? data.ui_results : []);
      setRawDataResult(data.raw_data);
      setEngineUsed(data.engine_used);
      setSavedScanPath(data.saved_scan_path || "");
      setCanonicalSelected(data.canonical_selected || "");
      setCanonicalDatasets(data.canonical_datasets || null);
      setScanStats(data.stats || null);
      loadHealth();
      setCurrentStep(4);
      setLivePhase("Completed");
      setPipelineState('completed');
      setLogs(prev => [...prev, `[${new Date().toISOString().split('T')[1].slice(0, 8)}] Scan complete using ${engineLabel(data.engine_used)}.`]);

    } catch (err: any) {
      clearInterval(progressInterval);
      setPipelineState('error');
      setLivePhase("Failed");
      setErrorMsg("Network error trying to connect to backend on port 3000. Is the server running?");
      console.error(err);
    }
  };

  const getSeverityBadge = (severity: string) => {
    if (!severity) return null;
    switch (severity.toLowerCase()) {
      case 'critical': return <span className="badge badge-critical">Critical</span>;
      case 'high': return <span className="badge badge-high">High</span>;
      case 'medium': return <span className="badge badge-medium">Medium</span>;
      default: return <span className="badge badge-low">Low</span>;
    }
  };

  const getMatchTypeBadge = (type: string) => {
    if (!type) return null;
    switch (type.toLowerCase()) {
      case 'match': return <span className="badge" style={{ background: 'rgba(61, 220, 151, 0.12)', color: '#35d089', border: '1px solid rgba(61, 220, 151, 0.35)' }}>Match</span>;
      case 'fuzzy_match': return <span className="badge" style={{ background: 'rgba(251, 192, 45, 0.1)', color: '#fbc02d', border: '1px solid rgba(251, 192, 45, 0.3)' }}>Fuzzy Match</span>;
      case 'no_match': return <span className="badge" style={{ background: 'rgba(255, 152, 0, 0.1)', color: '#ff9800', border: '1px solid rgba(255, 152, 0, 0.3)' }}>No Match</span>;
      default: return <span className="badge">Unknown</span>;
    }
  };

  const statusBadge = (ok: boolean, textTrue = "Ready", textFalse = "Not Ready") => (
    <span className={ok ? "badge badge-low" : "badge badge-critical"}>
      {ok ? textTrue : textFalse}
    </span>
  );

  const renderHealthPanel = () => (
    <div className="glass-card" style={{ padding: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Cpu size={20} className="logo-icon" style={{ background: 'transparent' }} />
          AI Model Health & Setup
        </h3>
        <button className="btn btn-secondary" onClick={loadHealth} disabled={healthLoading}>
          <RefreshCw size={14} />
          {healthLoading ? 'Checking...' : 'Refresh Health'}
        </button>
      </div>

      {healthError && (
        <div style={{ marginBottom: '1rem', color: 'var(--status-critical)', fontSize: '0.9rem' }}>
          {healthError}
        </div>
      )}

      {!aiHealth && !healthError ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Loading AI health...</div>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Selected Engine (Next Scan)</div>
              <div style={{ fontWeight: 600 }}>{engineLabel(aiHealth?.selected_engine || '')}</div>
            </div>
            {statusBadge(Boolean(aiHealth?.selected_engine), "Resolved", "Unknown")}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Anthropic</div>
              <div style={{ fontSize: '0.9rem' }}>
                Configured: <strong>{aiHealth?.anthropic?.configured ? 'Yes' : 'No'}</strong> | Being Used: <strong>{aiHealth?.anthropic?.being_used ? 'Yes' : 'No'}</strong>
              </div>
            </div>
            {statusBadge(Boolean(aiHealth?.anthropic?.configured), "Configured", "Missing Key")}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '0.75rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
            <div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Ollama</div>
              <div style={{ fontSize: '0.9rem' }}>
                Enabled: <strong>{aiHealth?.ollama?.enabled ? 'Yes' : 'No'}</strong> | Reachable: <strong>{aiHealth?.ollama?.reachable ? 'Yes' : 'No'}</strong> | Model Installed: <strong>{aiHealth?.ollama?.model_installed ? 'Yes' : 'No'}</strong>
              </div>
              {aiHealth?.ollama?.error && <div style={{ color: 'var(--status-medium)', fontSize: '0.8rem', marginTop: '0.25rem' }}>{aiHealth.ollama.error}</div>}
            </div>
            {statusBadge(Boolean(aiHealth?.ollama?.enabled && aiHealth?.ollama?.reachable && aiHealth?.ollama?.model_installed), "Ready", "Setup Needed")}
          </div>

          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Last scan engine used: <strong style={{ color: 'var(--text-primary)' }}>{engineLabel(aiHealth?.last_engine_used || '')}</strong>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="app-container">
      <header className="header">
        <div className="logo">
          <div className="logo-icon"><ShieldCheck size={28} /></div>
          UniData Recon Engine
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          {(pipelineState === 'completed' || pipelineState === 'error') && (
            <button className="btn btn-secondary" onClick={() => setPipelineState('idle')}>
              <RefreshCw size={16} /> New Scan
            </button>
          )}
          <button className="btn btn-primary" onClick={startScan} disabled={pipelineState === 'running'}>
            <Search size={16} />
            {pipelineState === 'running' ? 'Scanning (AI Analyzing)...' : pipelineState === 'completed' ? 'Re-Scan Network' : 'Start Audit'}
          </button>
        </div>
      </header>

      <main className="main-content">
        {pipelineState === 'idle' || pipelineState === 'running' || pipelineState === 'error' ? (
          <div className="view-container" style={{ maxWidth: '800px', margin: '4rem auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
              <h1 className="page-title">Dynamic Content Checker Pipeline</h1>
              <p className="page-subtitle" style={{ margin: '0 auto' }}>
                Run field-by-field consistency checks with claims-first matching and flat canonical fallback, then semantic adjudication via Ollama when needed.
              </p>
            </div>

            {pipelineState === 'error' && (
              <div className="glass-card" style={{ marginBottom: '2rem', border: '1px solid var(--status-critical)', background: 'rgba(255, 75, 75, 0.05)' }}>
                <h3 style={{ color: 'var(--status-critical)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <AlertTriangle size={20} /> Processing Failed
                </h3>
                <p style={{ color: 'var(--text-secondary)' }}>{errorMsg}</p>
              </div>
            )}

            <div className="glass-card" style={{ padding: '2rem' }}>
              <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Database size={20} className="logo-icon" style={{ background: 'transparent' }} />
                Environment Configuration
              </h3>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>AUTHORITATIVE SOURCE (CANONICAL)</label>
                <input
                  type="text"
                  value={canonicalUrl}
                  onChange={(e) => setCanonicalUrl(e.target.value)}
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-highlight)', color: 'var(--accent-secondary)', fontFamily: 'monospace', fontSize: '1rem', outline: 'none' }}
                  disabled={pipelineState === 'running'}
                />
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>SUBDOMAINS TO VERIFY (Comma Separated URLs)</label>
                <textarea
                  value={targetUrls}
                  onChange={(e) => setTargetUrls(e.target.value)}
                  rows={4}
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.9rem', outline: 'none', resize: 'vertical' }}
                  disabled={pipelineState === 'running'}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', fontWeight: 600 }}>WATCHED FIELDS (Data Consistency Rules)</label>
                <textarea
                  value={fields}
                  onChange={(e) => setFields(e.target.value)}
                  rows={2}
                  style={{ width: '100%', background: 'rgba(0,0,0,0.3)', padding: '0.85rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: '0.9rem', outline: 'none', resize: 'none' }}
                  disabled={pipelineState === 'running'}
                />
              </div>
            </div>
            {renderHealthPanel()}

            {pipelineState === 'running' && (
              <div className="glass-card animate-fade-in" style={{ marginTop: '2rem' }}>
                <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Cpu size={20} className="logo-icon" style={{ background: 'transparent' }} />
                  Live Processing Pipeline
                </h3>

                <div style={{ paddingLeft: '1rem' }}>
                    <div className={"pipeline-step " + (currentStep >= 1 ? "completed" : currentStep === 0 ? "active" : "")}>
                      <div className="step-icon"><Search size={18} /></div>
                      <div className="step-content">
                      <div className="step-title">1. Crawl and Normalize Sources</div>
                      <div className="step-desc">Fetch canonical + target URLs and extract clean snippet blocks.</div>
                      </div>
                    </div>
                    <div className={"pipeline-step " + (currentStep >= 2 ? "completed" : currentStep === 1 ? "active" : "")}>
                      <div className="step-icon"><Split size={18} /></div>
                      <div className="step-content">
                      <div className="step-title">2. Canonical Candidate Mapping</div>
                      <div className="step-desc">Resolve top claims and flat canon candidates per watched field.</div>
                      </div>
                    </div>
                    <div className={"pipeline-step " + (currentStep >= 3 ? "completed" : currentStep === 2 ? "active" : "")}>
                      <div className="step-icon"><Cpu size={18} /></div>
                      <div className="step-content">
                      <div className="step-title">3. Field-by-Field Adjudication</div>
                      <div className="step-desc">Deterministic matching first, then Ollama semantic checks for uncertain pairs.</div>
                      </div>
                    </div>
                  </div>

                <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '0.6rem' }}>
                  <div style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Phase</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{livePhase}</div>
                  </div>
                  <div style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Elapsed</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{elapsedSeconds}s</div>
                  </div>
                  <div style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Targets / Fields</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{runContext.targetCount} / {runContext.fieldCount}</div>
                  </div>
                  <div style={{ padding: '0.6rem', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Check Units</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{runContext.pairCount}</div>
                  </div>
                </div>

                <div className="log-window">
                  {logs.map((log, i) => (
                    <div key={i} className="log-line animate-fade-in">{log}</div>
                  ))}
                  <div className="log-line log-info animate-fade-in" style={{ animationDelay: '0.5s' }}>
                    <span className="pulse">Running comparison pipeline. Semantic stages can take several minutes for large runs.</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="view-container animate-fade-in">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem' }}>
              <div>
                <h1 className="page-title" style={{ fontSize: '2rem' }}>Audit Overview</h1>
                <p className="page-subtitle" style={{ marginBottom: 0 }}>
                  Successfully completed real-time network evaluation.
                  <span className={engineUsed === 'Anthropic_Claude' || engineUsed.startsWith('Ollama_') ? "badge badge-low" : "badge badge-medium"} style={{ marginLeft: '1rem' }}>
                    {`Powered by ${engineLabel(engineUsed)}`}
                  </span>
                </p>
              </div>

              <div className="tabs" style={{ marginBottom: 0 }}>
                <button className={`tab ${activeTab === 'structured' ? 'active' : ''}`} onClick={() => setActiveTab('structured')}>
                  <AlertTriangle size={16} /> Structured Schema
                </button>
                <button className={`tab ${activeTab === 'diff' ? 'active' : ''}`} onClick={() => setActiveTab('diff')}>
                  <Split size={16} /> Semantic Diff
                </button>
                <button className={`tab ${activeTab === 'raw' ? 'active' : ''}`} onClick={() => setActiveTab('raw')}>
                  <FileText size={16} /> Raw Payload Content
                </button>
              </div>
            </div>

            <div className="stats-grid">
              <div className="glass-card stat-card" style={{ borderTop: '3px solid var(--status-critical)' }}>
                <span className="stat-label">Non-Match Findings</span>
                <span className="stat-value">
                  {uiResults.filter((row: any) => row.status !== 'match').length}
                  <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 400 }}> rows</span>
                </span>
              </div>
              <div className="glass-card stat-card" style={{ borderTop: '3px solid var(--accent-primary)' }}>
                <span className="stat-label">Total URLs Scraped</span>
                <span className="stat-value">{rawDataResult.length} <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 400 }}>domains</span></span>
              </div>
              <div className="glass-card stat-card" style={{ borderTop: '3px solid var(--status-low)' }}>
                <span className="stat-label">Engine Used</span>
                <span className="stat-value" style={{ fontSize: '1.3rem' }}>{engineLabel(engineUsed)}</span>
              </div>
              <div className="glass-card stat-card" style={{ borderTop: '3px solid var(--status-medium)' }}>
                <span className="stat-label">Overall Consistency</span>
                <span className="stat-value">
                  {typeof scanStats?.overall_consistency_score === 'number'
                    ? `${(Number(scanStats.overall_consistency_score) * 100).toFixed(0)}%`
                    : '—'}
                </span>
              </div>
            </div>

            {(savedScanPath || canonicalSelected || canonicalDatasets) && (
              <div className="glass-card" style={{ marginBottom: '1rem', padding: '1rem 1.25rem' }}>
                {savedScanPath && (
                  <div style={{ fontSize: '0.9rem', marginBottom: canonicalDatasets ? '0.75rem' : 0 }}>
                    <strong>Saved Scan:</strong> <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{savedScanPath}</span>
                  </div>
                )}
                {canonicalSelected && (
                  <div style={{ fontSize: '0.9rem', marginBottom: canonicalDatasets ? '0.75rem' : 0 }}>
                    <strong>Canonical Base URL:</strong> <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{canonicalSelected}</span>
                  </div>
                )}
                {canonicalDatasets && (
                  <div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Canonical dataset endpoints and fallback sources</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Claims API: <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{canonicalDatasets.claims_url}</span> ({canonicalDatasets.claims_source}, count: {canonicalDatasets.claims_count})
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Flat API: <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{canonicalDatasets.flat_url}</span> ({canonicalDatasets.flat_source}, count: {canonicalDatasets.flat_entries_count})
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        Snapshot API: <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{canonicalDatasets.snapshot_url}</span> ({canonicalDatasets.snapshot_source})
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {renderHealthPanel()}

            <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
              {activeTab === 'structured' && (
                <div className="animate-fade-in">
                  <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Post-Hoc Inconsistencies Extracted</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                      These findings were automatically clustered and extracted by the matcher. Contract rows returned: {contractResults.length}.
                    </p>
                  </div>

                  {uiResults.length === 0 ? (
                    <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No specific variations were flagged or the AI produced a generalized output. Try adjusting search criteria fields.
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Watched Field</th>
                          <th>Target URL</th>
                          <th>Canonical Source</th>
                          <th>Found Value</th>
                          <th>Status</th>
                          <th>Match Severity</th>
                          <th>AI Confidence</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uiResults.map((row: any, idx: number) => {
                          let hostname = "unknown";
                          try { hostname = new URL(row.target_url).hostname; } catch (e) { }
                          return (
                            <tr key={`${row.watched_field}-${row.target_url}-${idx}`}>
                              <td>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                  <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{row.watched_field}</span>
                                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{row.canonical_ref || 'No canonical ref'}</span>
                                </div>
                              </td>
                              <td>
                                <a href={row.target_url} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                  {hostname}
                                  <ExternalLink size={12} />
                                </a>
                              </td>
                              <td style={{ maxWidth: '260px' }}>{row.canonical_source || '—'}</td>
                              <td style={{ maxWidth: '260px' }}>{row.found_value || '—'}</td>
                              <td>{getMatchTypeBadge(row.status)}</td>
                              <td>{getSeverityBadge(row.match_severity)}</td>
                              <td>{typeof row.confidence === 'number' ? `${(Number(row.confidence) * 100).toFixed(0)}%` : '—'}</td>
                              <td style={{ maxWidth: '280px' }}>{row.reason || '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'diff' && (
                <div className="animate-fade-in" style={{ padding: '2rem' }}>
                  <div style={{ marginBottom: '2rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Semantic Differential View</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>Canonical truth vs found data mapped side by side from the AI's contextual interpretation.</p>
                  </div>

                  {uiResults.length === 0 ? (
                    <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>No Diffable Conflicts Flagged.</div>
                  ) : null}

                  {uiResults.map((row: any, i: number) => {
                    let canonicalHost = "canonical";
                    let conflictHost = "target";
                    try { canonicalHost = new URL(canonicalSelected || rawDataResult[0]?.url).hostname; } catch (e) { }
                    try { conflictHost = new URL(row.target_url).hostname; } catch (e) { }

                    return (
                      <div key={`${row.watched_field}-${i}`} className="item-row">
                        <div className="item-meta">
                          <div className="item-field-name">{String(row.watched_field || '').toUpperCase()}</div>
                          <div style={{ marginTop: '0.5rem' }}>{getSeverityBadge(row.match_severity)}</div>
                          <div style={{ marginTop: '0.25rem' }}>{getMatchTypeBadge(row.status)}</div>
                          {typeof row.confidence === 'number' && (
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                              <CheckCircle2 size={12} style={{ color: 'var(--status-low)' }} />
                              AI Confidence: {(Number(row.confidence) * 100).toFixed(0)}%
                            </div>
                          )}
                        </div>

                        <div className="diff-grid">
                          <div className="diff-box">
                            <div className="diff-box-header">
                              <span>Canonical Truth</span>
                              <span className="diff-source">{canonicalHost}</span>
                            </div>
                            <div className="diff-content" style={{ marginTop: '1rem', fontSize: '1.2rem', fontWeight: 600 }}>
                              <span className="highlight-add">{row.canonical_source || '—'}</span>
                            </div>
                          </div>

                          <div className="diff-box">
                            <div className="diff-box-header">
                              <span>Found Value in Wild</span>
                              <span className="diff-source" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' }} title={row.target_url}>{conflictHost}</span>
                            </div>
                            <div className="diff-content" style={{ marginTop: '1rem', fontSize: '1.2rem', fontWeight: 600 }}>
                              <span className="highlight-remove">{row.found_value || '—'}</span>
                            </div>
                            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-color)' }}>
                              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Reason</div>
                              <div style={{ fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--text-primary)' }}>
                                "{row.reason || 'No reason provided.'}"
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {activeTab === 'raw' && (
                <div className="animate-fade-in" style={{ padding: '2rem' }}>
                  <div style={{ marginBottom: '2rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Unstructured Crawl Payload</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>Raw extracted text used by deterministic and semantic matching stages (scraped locally via Node.js Cheerio).</p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                    {rawDataResult.map((page, i) => (
                      <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <ServerCrash size={16} className={page.success ? "text-secondary" : "text-danger"} />
                            <a href={page.url} target="_blank" rel="noreferrer" style={{ fontFamily: 'monospace', color: page.success ? 'var(--accent-secondary)' : '#ff4b4b' }}>
                              {page.url}
                            </a>
                            {i === 0 && <span className="badge badge-low" style={{ marginLeft: '0.5rem' }}>Canonical</span>}
                          </div>
                          <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            <span>Paragraphs Chunked: {page.chunks}</span>
                            <span>Characters: {page.extracted_text?.length}</span>
                          </div>
                        </div>
                        <div className="raw-code" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                          {page.extracted_text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
