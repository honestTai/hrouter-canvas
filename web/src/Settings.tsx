import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { api, type AppState, type Site, type VideoSite } from './api';

// Image sites and video sites are separate lists with separate keys: a picture made on one site
// can be animated on another. Both edit the same way.
type Kind = 'image' | 'video';
interface Draft {
  kind: Kind;
  id: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
}
const KINDS = {
  image: {
    title: '生图站点',
    path: 'sites',
    protocols: [
      ['auto', '自动（gemini- 开头的模型走 Gemini，其余走 OpenAI Images）'],
      ['openai', 'OpenAI Images（/v1/images/generations）'],
      ['gemini', 'Gemini 原生（generateContent）'],
    ],
    modelHint: '手动添加模型名，例如 gpt-image-2',
    empty: '还没有模型。可从站点获取，或手动填写模型名。',
    keyHint: '',
  },
  video: {
    title: '生视频站点',
    path: 'video-sites',
    protocols: [
      ['auto', '自动（sora- 开头的模型走 OpenAI Videos，其余走 /videos/generations）'],
      ['xai', 'HRouter / xAI 异步任务（/v1/videos/generations）'],
      ['openai', 'OpenAI Videos（/v1/videos）'],
    ],
    modelHint: '手动添加模型名，例如 grok-imagine-video-1.5',
    empty: '还没有视频模型。可从站点获取，或手动填写模型名。',
    keyHint: '和生图站点的 Key 分开填。HRouter 生视频需要 grok 分组的 Key。',
  },
} as const;

const draftOf = (kind: Kind, site: Site | VideoSite): Draft => ({
  kind,
  id: site.id,
  isNew: false,
  name: site.name,
  baseUrl: site.baseUrl,
  protocol: site.protocol,
  apiKey: '',
  models: site.models,
  defaultModel: site.defaultModel || '',
});
const blank = (kind: Kind): Draft => ({
  kind,
  id: `${kind === 'video' ? 'video' : 'site'}-${Math.random().toString(36).slice(2, 8)}`,
  isNew: true,
  name: '',
  baseUrl: '',
  protocol: 'auto',
  apiKey: '',
  models: [],
  defaultModel: '',
});

// One editable list of model ids: chips to remove, a box to add by hand, and found suggestions.
function ModelList(props: {
  models: string[];
  onChange: (models: string[]) => void;
  found?: string[];
  empty: string;
  placeholder: string;
  children?: ReactNode;
}) {
  const [adding, setAdding] = useState('');
  const toggle = (id: string) =>
    props.onChange(props.models.includes(id) ? props.models.filter((m) => m !== id) : [...props.models, id]);
  const add = () => {
    const id = adding.trim();
    if (id && !props.models.includes(id)) props.onChange([...props.models, id]);
    setAdding('');
  };
  const suggestions = props.found?.filter((id) => !props.models.includes(id)) || [];
  return (
    <>
      <div className="chips">
        {props.models.map((id) => (
          <button type="button" key={id} className="chip on" onClick={() => toggle(id)}>
            {id} <X size={11} />
          </button>
        ))}
        {!props.models.length && <small>{props.empty}</small>}
      </div>
      <div className="inline">
        <input
          value={adding}
          placeholder={props.placeholder}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            add();
          }}
        />
        <button type="button" onClick={add} disabled={!adding.trim()}>
          添加
        </button>
        {props.children}
      </div>
      {suggestions.length > 0 && (
        <div className="chips found">
          {suggestions.map((id) => (
            <button type="button" key={id} className="chip" onClick={() => toggle(id)}>
              <Plus size={11} /> {id}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export default function Settings(props: { state: AppState; onClose: () => void }) {
  const { state } = props;
  const listOf = (kind: Kind): Array<Site | VideoSite> => (kind === 'video' ? state.videoSites : state.sites);
  const defaultOf = (kind: Kind) => (kind === 'video' ? state.defaultVideoSite : state.defaultSite);
  const [draft, setDraft] = useState<Draft>(() =>
    state.sites.length
      ? draftOf('image', state.sites.find((s) => s.id === state.defaultSite) || state.sites[0])
      : blank('image'),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [found, setFound] = useState<{ all: string[]; suggested: string[]; video: string[] } | null>(
    null,
  );
  const [showAll, setShowAll] = useState(false);
  const kind = KINDS[draft.kind];
  const saved = listOf(draft.kind).find((s) => s.id === draft.id);
  const isDefault = saved && saved.id === defaultOf(draft.kind);
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
  const endpoint = `${kind.path}/${draft.id}`;
  const save = () =>
    api<Site | VideoSite>(endpoint, {
      method: 'PUT',
      json: {
        name: draft.name || draft.baseUrl.replace(/^https?:\/\//, ''),
        baseUrl: draft.baseUrl,
        protocol: draft.protocol,
        models: draft.models,
        defaultModel: draft.models.includes(draft.defaultModel) ? draft.defaultModel : undefined,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      },
    }).then((site) => setDraft(draftOf(draft.kind, site)));
  const suggestions = found
    ? showAll
      ? found.all
      : draft.kind === 'video'
        ? found.video
        : found.suggested
    : undefined;
  const group = (k: Kind) => (
    <>
      <small className="site-group">{KINDS[k].title}</small>
      {listOf(k).map((site) => (
        <button
          key={`${k}:${site.id}`}
          className={draft.kind === k && site.id === draft.id ? 'active' : ''}
          onClick={() => pick(draftOf(k, site))}
        >
          <strong>{site.name}</strong>
          <small>{site.hasKey ? (site.id === defaultOf(k) ? '默认' : '已配置') : '未填 Key'}</small>
        </button>
      ))}
      <button className={draft.kind === k && draft.isNew ? 'active add' : 'add'} onClick={() => pick(blank(k))}>
        <Plus size={14} /> 添加{KINDS[k].title}
      </button>
    </>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="站点设置">
        <header>
          <h2>生图与生视频站点</h2>
          <button className="icon-button" onClick={props.onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="settings-body">
          <nav className="site-list" aria-label="站点列表">
            {group('image')}
            {group('video')}
          </nav>
          <form
            className="site-form"
            aria-label={kind.title}
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await save();
                return '已保存';
              });
            }}
          >
            <p className="form-kind">{draft.isNew ? `添加${kind.title}` : kind.title}</p>
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
              <select value={draft.protocol} onChange={(e) => edit({ protocol: e.target.value })}>
                {kind.protocols.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
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
              <small>
                {kind.keyHint}只保存在本机的 ~/.hrouter-canvas/config.json，页面和 agent 都读不回来。
              </small>
            </label>
            <div className="field">
              <span>{draft.kind === 'video' ? '视频模型' : '模型'}</span>
              <ModelList
                models={draft.models}
                onChange={(models) => edit({ models })}
                found={suggestions}
                empty={kind.empty}
                placeholder={kind.modelHint}
              >
                <button
                  type="button"
                  disabled={busy || !draft.baseUrl || (!draft.apiKey && !saved?.hasKey)}
                  onClick={() =>
                    void run(async () => {
                      // Saving first means the test uses exactly what will be used to generate.
                      await save();
                      const result = await api<{ all: string[]; suggested: string[]; video: string[] }>(
                        `${endpoint}/models`,
                        { method: 'POST' },
                      );
                      setFound(result);
                      const likely = draft.kind === 'video' ? result.video : result.suggested;
                      return `连接成功，站点提供 ${result.all.length} 个模型，其中 ${likely.length} 个像是${draft.kind === 'video' ? '视频' : '生图'}模型`;
                    })
                  }
                >
                  测试并获取模型
                </button>
              </ModelList>
              {found && found.all.length > (suggestions?.length || 0) && (
                <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
                  {showAll ? '只看推荐的模型' : `显示全部 ${found.all.length} 个`}
                </button>
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
                    if (!confirm(`删除站点“${saved.name}”？已生成的内容不受影响。`)) return;
                    void run(async () => {
                      await api(endpoint, { method: 'DELETE' });
                      const rest = listOf(draft.kind).filter((s) => s.id !== saved.id);
                      pick(rest.length ? draftOf(draft.kind, rest[0]) : blank(draft.kind));
                    });
                  }}
                >
                  <Trash2 size={13} /> 删除
                </button>
              )}
              <span className="spacer" />
              {saved?.hasKey && !isDefault && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`${endpoint}/default`, { method: 'POST' });
                      return `已设为默认${kind.title}`;
                    })
                  }
                >
                  设为默认{kind.title}
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
