import { useState } from 'react';
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

  // Input Settings
  const [canonicalUrl, setCanonicalUrl] = useState("https://en.wikipedia.org/wiki/Harvard_University");
  const [targetUrls, setTargetUrls] = useState("https://en.wikipedia.org/wiki/Harvard_Law_School, https://en.wikipedia.org/wiki/Harvard_Business_School");
  const [fields, setFields] = useState("President, Motto, Main Campus Location, Founding Year");

  // Output State
  const [resultsData, setResultsData] = useState<any>({});
  const [rawDataResult, setRawDataResult] = useState<any[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [engineUsed, setEngineUsed] = useState("");

  const startScan = async () => {
    if (!canonicalUrl || !targetUrls) return;
    setPipelineState('running');
    setCurrentStep(0);
    setLogs(["Initializing verification pipeline..."]);
    setErrorMsg("");
    setEngineUsed("");

    // Convert strings to array format for backend
    const urlsArray = targetUrls.split(',').map(u => u.trim()).filter(u => u);
    const fieldsArray = fields.split(',').map(f => f.trim()).filter(f => f);

    // Simulated async logs for UI feedback while waiting for real backend
    const logInterval = setInterval(() => {
      setCurrentStep(s => (s < 3 ? s + 1 : s));
    }, 4000); // Progress the UI visually every 4 seconds

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

      clearInterval(logInterval);
      const data = await resp.json();

      if (!resp.ok) {
        setPipelineState('error');
        setErrorMsg(data.error || "Failed to scan data from server.");
        return;
      }

      setResultsData(data.results);
      setRawDataResult(data.raw_data);
      setEngineUsed(data.engine_used);
      setCurrentStep(4);
      setPipelineState('completed');
      setLogs(prev => [...prev, `[${new Date().toISOString().split('T')[1].slice(0, 8)}] Scan complete using ${data.engine_used === 'Anthropic_Claude' ? 'Claude 3.5 Sonnet LLM' : 'Free Local Regex Heuristics'}.`]);

    } catch (err: any) {
      clearInterval(logInterval);
      setPipelineState('error');
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
      case 'mismatch': return <span className="badge" style={{ background: 'rgba(255, 75, 75, 0.1)', color: '#ff4b4b', border: '1px solid rgba(255, 75, 75, 0.3)' }}>Mismatch</span>;
      case 'fuzzy_match': return <span className="badge" style={{ background: 'rgba(251, 192, 45, 0.1)', color: '#fbc02d', border: '1px solid rgba(251, 192, 45, 0.3)' }}>Fuzzy Match</span>;
      default: return <span className="badge">Unknown</span>;
    }
  };

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
                Run semantic factual difference detection using Anthropic Claude. Automatically extracts raw content across unaligned structures and clusters knowledge.
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
                      <div className="step-title">1. Raw Text Extraction</div>
                      <div className="step-desc">Fetching URLs across subdomains and stripping the DOM structure.</div>
                    </div>
                  </div>
                  <div className={"pipeline-step " + (currentStep >= 2 ? "completed" : currentStep === 1 ? "active" : "")}>
                    <div className="step-icon"><Split size={18} /></div>
                    <div className="step-content">
                      <div className="step-title">2. Context Chunking</div>
                      <div className="step-desc">Cleaning text constraints and normalizing content density.</div>
                    </div>
                  </div>
                  <div className={"pipeline-step " + (currentStep >= 3 ? "completed" : currentStep === 2 ? "active" : "")}>
                    <div className="step-icon"><Cpu size={18} /></div>
                    <div className="step-content">
                      <div className="step-title">3. Multi-prompt Fact Resolution via AI</div>
                      <div className="step-desc">LLM actively reconciling unstructured dumps against the watched schema vectors.</div>
                    </div>
                  </div>
                </div>

                <div className="log-window">
                  {logs.map((log, i) => (
                    <div key={i} className="log-line animate-fade-in">{log}</div>
                  ))}
                  <div className="log-line log-info animate-fade-in" style={{ animationDelay: '0.5s' }}>
                    <span className="pulse">Processing HTTP requests and reading AI stream...</span>
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
                  <span className={engineUsed === 'Anthropic_Claude' ? "badge badge-low" : "badge badge-medium"} style={{ marginLeft: '1rem' }}>
                    {engineUsed === 'Anthropic_Claude' ? "Powered by Claude AI" : "Powered by Free Local Heuristics"}
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
                <span className="stat-label">Inconsistent Fields</span>
                <span className="stat-value">{Object.keys(resultsData).length} <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 400 }}>total</span></span>
              </div>
              <div className="glass-card stat-card" style={{ borderTop: '3px solid var(--accent-primary)' }}>
                <span className="stat-label">Total URLs Scraped</span>
                <span className="stat-value">{rawDataResult.length} <span style={{ fontSize: '1rem', color: 'var(--text-muted)', fontWeight: 400 }}>domains</span></span>
              </div>
            </div>

            <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
              {activeTab === 'structured' && (
                <div className="animate-fade-in">
                  <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Post-Hoc Inconsistencies Extracted</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>These findings were automatically clustered and extracted by the AI based completely on reading raw text.</p>
                  </div>

                  {Object.keys(resultsData).length === 0 ? (
                    <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      No specific variations were flagged or the AI produced a generalized output. Try adjusting search criteria fields.
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Auto-Inferred Schema</th>
                          <th>Canonical Truth Anchor</th>
                          <th>Severity Matrix</th>
                          <th>Stale/Variant Entities</th>
                          <th>Conflict Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(resultsData).map(([field, data]: [string, any]) => (
                          <tr key={field}>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ fontFamily: 'monospace', color: 'var(--accent-secondary)' }}>{field}</span>
                                <span style={{ fontSize: '0.75rem', background: 'rgba(255,255,255,0.05)', padding: '0.1rem 0.4rem', borderRadius: '4px', color: 'var(--text-muted)' }}>{data.type}</span>
                              </div>
                            </td>
                            <td style={{ fontWeight: 500 }}>{data.canonical}</td>
                            <td>{getSeverityBadge(data.severity)}</td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {(data.conflicts || []).map((c: any, i: number) => {
                                  let hostname = "unknown";
                                  try { hostname = new URL(c.url).hostname; } catch (e) { }
                                  return (
                                    <a key={i} href={c.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                      {hostname}
                                      <ExternalLink size={12} />
                                    </a>
                                  )
                                })}
                              </div>
                            </td>
                            <td>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {(data.conflicts || []).map((c: any, i: number) => (
                                  <div key={i}>{getMatchTypeBadge(c.type)}</div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
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

                  {Object.keys(resultsData).length === 0 ? (
                    <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>No Diffable Conflicts Flagged.</div>
                  ) : null}

                  {Object.entries(resultsData).map(([field, data]: [string, any]) => (
                    (data.conflicts || []).map((conflict: any, i: number) => {
                      let canonicalHost = "canonical";
                      let conflictHost = "target";
                      try { canonicalHost = new URL(rawDataResult[0]?.url).hostname; } catch (e) { }
                      try { conflictHost = new URL(conflict.url).hostname; } catch (e) { }

                      return (
                        <div key={`${field}-${i}`} className="item-row">
                          <div className="item-meta">
                            <div className="item-field-name">{field.replace(/_/g, ' ').toUpperCase()}</div>
                            <div style={{ marginTop: '0.5rem' }}>{getSeverityBadge(data.severity)}</div>
                            <div style={{ marginTop: '0.25rem' }}>{getMatchTypeBadge(conflict.type)}</div>
                            {conflict.confidence && (
                              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                <CheckCircle2 size={12} style={{ color: 'var(--status-low)' }} />
                                AI Confidence: {(Number(conflict.confidence) * 100).toFixed(0)}%
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
                                <span className="highlight-add">{data.canonical}</span>
                              </div>
                            </div>

                            <div className="diff-box">
                              <div className="diff-box-header">
                                <span>Found Value in Wild</span>
                                <span className="diff-source" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' }} title={conflict.url}>{conflictHost}</span>
                              </div>
                              <div className="diff-content" style={{ marginTop: '1rem', fontSize: '1.2rem', fontWeight: 600 }}>
                                <span className="highlight-remove">{conflict.found}</span>
                              </div>
                              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-color)' }}>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Extracted Context Snippet</div>
                                <div style={{ fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--text-primary)' }}>
                                  "{conflict.snippet}"
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    })
                  ))}
                </div>
              )}

              {activeTab === 'raw' && (
                <div className="animate-fade-in" style={{ padding: '2rem' }}>
                  <div style={{ marginBottom: '2rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Unstructured Crawl Payload</h3>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>The exact raw text array dumped out to Anthropic's context window. (Scraped locally via Node.js Cheerio).</p>
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
