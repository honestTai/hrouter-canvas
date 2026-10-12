import { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { api, type AppState, type Site } from './api';

interface Draft {
  id: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  protocol: Site['protocol'];
  apiKey: string;
  models: string[];
  defaultModel: string;
}
const draftOf = (site: Site): Draft => ({
  id: site.id,
  isNew: false,
  name: site.name,
  baseUrl: site.baseUrl,
  protocol: site.protocol,
  apiKey: '',
  models: site.models,
  defaultModel: site.defaultModel || '',
});
const blank = (): Draft => ({
  id: `site-${Math.random().toString(36).slice(2, 8)}`,
  isNew: true,
  name: '',
  baseUrl: '',
  protocol: 'auto',
  apiKey: '',
  models: [],
  defaultModel: '',
});

export default function Settings(props: { state: AppState; onClose: () => void }) {
  const { state } = props;
  const [draft, setDraft] = useState<Draft>(() =>
    state.sites.length
      ? draftOf(state.sites.find((s) => s.id === state.defaultSite) || state.sites[0])
      : blank(),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [found, setFound] = useState<{ all: string[]; suggested: string[] } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState('');
  const saved = state.sites.find((s) => s.id === draft.id);
  const edit = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const pick = (next: Draft) => {
    setDraft(next);
    setMessage(null);
    setFound(null);
    setShowAll(false);
  };
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [props]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ ok: true, text });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '操作失败' });
    } finally {
      setBusy(false);
    }
  };
  const save = (models = draft.models) =>
    api<Site>(`sites/${draft.id}`, {
      method: 'PUT',
      json: {
        name: draft.name || draft.baseUrl.replace(/^https?:\/\//, ''),
        baseUrl: draft.baseUrl,
        protocol: draft.protocol,
        models,
        defaultModel: models.includes(draft.defaultModel) ? draft.defaultModel : undefined,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
    }).then((site) => setDraft(draftOf(site)));
  const toggleModel = (id: string) =>
    edit({
      models: draft.models.includes(id)
        ? draft.models.filter((m) => m !== id)
        : [...draft.models, id],
    });
  const addModel = () => {
    const id = adding.trim();
    if (id && !draft.models.includes(id)) edit({ models: [...draft.models, id] });
    setAdding('');
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="生图站点设置">
        <header>
          <h2>生图站点</h2>
          <button className="icon-button" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="site-list" aria-label="站点列表">
            {state.sites.map((site) => (
              <button
                key={site.id}
                className={site.id === draft.id ? 'active' : ''}
                onClick={() => pick(draftOf(site))}
              >
                <strong>{site.name}</strong>
                <small>
                  {site.hasKey ? (site.id === state.defaultSite ? '默认站点' : '已配置') : '未填 Key'}
                </small>
              </button>
            ))}
            <button className={draft.isNew ? 'active add' : 'add'} onClick={() => pick(blank())}>
              <Plus size={14} /> 添加站点
            </button>
          </nav>
          <form
            className="site-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await save();
                return '已保存';
              });
            }}
          >
            <label>
              名称
              <input
                value={draft.name}
                maxLength={40}
                placeholder="例如 我的中转站"
                onChange={(e) => edit({ name: e.target.value })}
              />
            </label>
            <label>
              站点地址
              <input
                value={draft.baseUrl}
                required
                inputMode="url"
                placeholder="https://example.com"
                onChange={(e) => edit({ baseUrl: e.target.value })}
              />
              <small>填站点根地址或以 /v1 结尾的 API 地址均可。</small>
            </label>
            <label>
              协议
              <select
                value={draft.protocol}
                onChange={(e) => edit({ protocol: e.target.value as Site['protocol'] })}
              >
                <option value="auto">自动（gemini- 开头的模型走 Gemini，其余走 OpenAI Images）</option>
                <option value="openai">OpenAI Images（/v1/images/generations）</option>
                <option value="gemini">Gemini 原生（generateContent）</option>
              </select>
            </label>
            <label>
              API Key
              <input
                type="password"
                value={draft.apiKey}
                autoComplete="off"
                placeholder={saved?.hasKey ? `已保存 ${saved.keyHint}，留空则不修改` : 'sk-…'}
                onChange={(e) => edit({ apiKey: e.target.value })}
              />
              <small>只保存在本机的 ~/.hrouter-canvas/config.json，页面和 agent 都读不回来。</small>
            </label>
            <div className="field">
              <span>模型</span>
              <div className="chips">
                {draft.models.map((id) => (
                  <button type="button" key={id} className="chip on" onClick={() => toggleModel(id)}>
                    {id} <X size={11} />
                  </button>
                ))}
                {!draft.models.length && <small>还没有模型。可从站点获取，或手动填写模型名。</small>}
              </div>
              <div className="inline">
                <input
                  value={adding}
                  placeholder="手动添加模型名，例如 gpt-image-2"
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    addModel();
                  }}
                />
                <button type="button" onClick={addModel} disabled={!adding.trim()}>
                  添加
                </button>
                <button
                  type="button"
                  disabled={busy || !draft.baseUrl || (!draft.apiKey && !saved?.hasKey)}
                  onClick={() =>
                    void run(async () => {
                      // Saving first means the test uses exactly what will be used to generate.
                      await save();
                      const result = await api<{ all: string[]; suggested: string[] }>(
                        `sites/${draft.id}/models`,
                        { method: 'POST' },
                      );
                      setFound(result);
                      return `连接成功，站点提供 ${result.all.length} 个模型，其中 ${result.suggested.length} 个像是生图模型`;
                    })
                  }
                >
                  测试并获取模型
                </button>
              </div>
              {found && (
                <div className="chips found">
                  {(showAll ? found.all : found.suggested)
                    .filter((id) => !draft.models.includes(id))
                    .map((id) => (
                      <button type="button" key={id} className="chip" onClick={() => toggleModel(id)}>
                        <Plus size={11} /> {id}
                      </button>
                    ))}
                  {found.all.length > found.suggested.length && (
                    <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
                      {showAll ? '只看生图模型' : `显示全部 ${found.all.length} 个`}
                    </button>
                  )}
                </div>
              )}
            </div>
            {draft.models.length > 1 && (
              <label>
                默认模型
                <select
                  value={draft.defaultModel}
                  onChange={(e) => edit({ defaultModel: e.target.value })}
                >
                  <option value="">第一个（{draft.models[0]}）</option>
                  {draft.models.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
            )}
            {message && (
              <p className={message.ok ? 'notice ok' : 'notice bad'} role="status">
                {message.text}
              </p>
            )}
            <footer>
              {saved && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`删除站点“${saved.name}”？已生成的图片不受影响。`)) return;
                    void run(async () => {
                      await api(`sites/${saved.id}`, { method: 'DELETE' });
                      const rest = state.sites.filter((s) => s.id !== saved.id);
                      pick(rest.length ? draftOf(rest[0]) : blank());
                    });
                  }}
                >
                  <Trash2 size={13} /> 删除
                </button>
              )}
              <span className="spacer" />
              {saved?.hasKey && saved.id !== state.defaultSite && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`sites/${saved.id}/default`, { method: 'POST' });
                      return '已设为默认站点';
                    })
                  }
                >
                  设为默认
                </button>
              )}
              <button type="submit" className="primary" disabled={busy || !draft.baseUrl}>
                保存
              </button>
            </footer>
          </form>
        </div>
      </div>
    </div>
  );
}
