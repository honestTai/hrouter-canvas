import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clapperboard,
  ImagePlus,
  Loader2,
  Moon,
  Plus,
  Settings as Cog,
  Sparkles,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { Viewport } from '@xyflow/react';
import { api, APIError, authorize, imageUrl, isVideo, type AppState, type Board, type VideoJob } from './api';
import Canvas from './Canvas';
import { captureFrames, type FrameRequest } from './frames';
import Settings from './Settings';

const RATIOS = ['', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];
const DURATIONS = ['', '5', '8', '10', '15'];
const VIDEO_RESOLUTIONS = ['', '480p', '720p'];
const local = {
  get(key: string) {
    try {
      return localStorage.getItem(`hrouter-canvas:${key}`) || '';
    } catch {
      return '';
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`hrouter-canvas:${key}`, value);
    } catch {
      // Preferences are a convenience; the page works without storage.
    }
  },
};

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [locked, setLocked] = useState(false);
  const [offline, setOffline] = useState(false);
  const [settings, setSettings] = useState(false);
  const [dark, setDark] = useState(
    () => (local.get('dark') || String(matchMedia('(prefers-color-scheme: dark)').matches)) === 'true',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(() => local.get('draft'));
  const [siteId, setSiteId] = useState(() => local.get('site'));
  const [model, setModel] = useState(() => local.get('model'));
  const [ratio, setRatio] = useState(() => local.get('ratio'));
  const [resolution, setResolution] = useState(() => local.get('resolution'));
  const [count, setCount] = useState(1);
  const [mode, setMode] = useState<'image' | 'video'>(() => (local.get('mode') === 'video' ? 'video' : 'image'));
  const [videoSiteId, setVideoSiteId] = useState(() => local.get('video-site'));
  const [videoModel, setVideoModel] = useState(() => local.get('video-model'));
  const [duration, setDuration] = useState(() => local.get('duration'));
  const [videoResolution, setVideoResolution] = useState(() => local.get('video-resolution'));
  const [running, setRunning] = useState(0);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);

  const fail = useCallback((e: unknown) => {
    if (e instanceof APIError && e.status === 401) return setLocked(true);
    setError(e instanceof Error ? e.message : '操作失败');
  }, []);
  const loadedVersion = useRef('');
  const refresh = useCallback(async () => {
    try {
      const next = await api<AppState>('state');
      // The service restarts itself on update; an open tab must not run old code on new data.
      if (loadedVersion.current && loadedVersion.current !== next.version) return location.reload();
      loadedVersion.current = next.version;
      setState(next);
      setBoard(await api<Board>(`boards/${next.current}`));
      setLocked(false);
      setOffline(false);
    } catch (e) {
      if (e instanceof APIError) fail(e);
      else setOffline(true);
    }
  }, [fail]);

  useEffect(() => {
    let events: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void authorize().then(async ({ settings }) => {
      await refresh();
      if (settings) setSettings(true);
      events = new EventSource('/api/events');
      // Coalesce bursts (several images landing together) into one refetch.
      events.addEventListener('change', () => {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 60);
      });
      events.addEventListener('hello', () => void refresh());
      // The service has no ffmpeg and needs this page to decode a video frame for an agent.
      events.addEventListener('frames', (e) => {
        const request = JSON.parse((e as MessageEvent).data) as FrameRequest;
        void captureFrames(request)
          .then((body) => api(`frames/${request.id}`, { body }))
          .catch(() => {});
      });
      events.onerror = () => setOffline(true);
    });
    return () => {
      events?.close();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    local.set('dark', String(dark));
  }, [dark]);
  useEffect(() => local.set('draft', prompt), [prompt]);
  useEffect(() => {
    local.set('site', siteId);
    local.set('model', model);
    local.set('ratio', ratio);
    local.set('resolution', resolution);
    local.set('mode', mode);
    local.set('video-site', videoSiteId);
    local.set('video-model', videoModel);
    local.set('duration', duration);
    local.set('video-resolution', videoResolution);
  }, [siteId, model, ratio, resolution, mode, videoSiteId, videoModel, duration, videoResolution]);
  const waiting = board?.pending.length || 0;
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting]);
  // Ids from another board or deleted images must not linger as references.
  useEffect(() => {
    if (!board) return;
    const ids = new Set(board.images.map((i) => i.id));
    setReferences((refs) => (refs.every((id) => ids.has(id)) ? refs : refs.filter((id) => ids.has(id))));
  }, [board]);

  const usable = state?.sites.filter((s) => s.hasKey) || [];
  const site =
    usable.find((s) => s.id === siteId) || usable.find((s) => s.id === state?.defaultSite) || usable[0];
  const activeModel = site
    ? site.models.includes(model)
      ? model
      : site.defaultModel || site.models[0] || ''
    : '';
  const hd = /^gemini-/i.test(activeModel) || site?.protocol === 'gemini';
  // Video has its own site and model: the key that draws may not be allowed to make videos.
  const videoSites = state?.videoSites.filter((s) => s.hasKey && s.models.length) || [];
  const videoSite =
    videoSites.find((s) => s.id === videoSiteId) ||
    videoSites.find((s) => s.id === state?.defaultVideoSite) ||
    videoSites[0];
  const activeVideoModel = videoSite
    ? videoSite.models.includes(videoModel)
      ? videoModel
      : videoSite.defaultModel || videoSite.models[0]
    : '';
  const startFrame = references[0];
  const continuing = !!board?.images.some((i) => i.id === startFrame && isVideo(i));
  const videoMode = mode === 'video';
  const ready = videoMode ? !!videoSite : !!site;

  const patch = useCallback(
    (body: Record<string, unknown>) => {
      if (board) void api(`boards/${board.id}`, { method: 'PATCH', json: body }).catch(fail);
    },
    [board, fail],
  );
  const onPositions = useCallback(
    (positions: Array<{ id: string; x: number; y: number }>) => patch({ positions }),
    [patch],
  );
  const onViewport = useCallback((viewport: Viewport) => patch({ viewport }), [patch]);
  const onEdges = useCallback(
    (edges: Array<{ id?: string; source: string; target: string }>) => patch({ edges }),
    [patch],
  );
  const onSelect = useCallback(
    (ids: string[]) =>
      setSelected((current) =>
        current.length === ids.length && current.every((id, i) => id === ids[i]) ? current : ids,
      ),
    [],
  );
  const onReference = useCallback(
    (id: string) =>
      setReferences((refs) =>
        refs.includes(id) ? refs.filter((r) => r !== id) : refs.length < 8 ? [...refs, id] : refs,
      ),
    [],
  );
  const onVideo = useCallback((id: string) => {
    setMode('video');
    setReferences([id]);
  }, []);
  const onFrame = useCallback(
    (id: string, at: 'first' | 'last' | number) =>
      void api(`items/${id}/frame`, { json: { at } }).catch(fail),
    [fail],
  );
  // Agents read the selection, so "change the one I selected" refers to the same thing.
  useEffect(() => {
    if (!board) return;
    const timer = setTimeout(
      () => void api(`boards/${board.id}/selection`, { json: { ids: selected } }).catch(() => {}),
      150,
    );
    return () => clearTimeout(timer);
  }, [board?.id, selected]);
  const onDelete = useCallback(
    (ids: string[]) => {
      if (!board || !ids.length) return;
      if (!confirm(`删除 ${ids.length} 项？本机画布目录中的原文件也会被移除。`)) return;
      void Promise.all(
        ids.map((id) => api(`boards/${board.id}/images/${id}`, { method: 'DELETE' })),
      ).catch(fail);
    },
    [board, fail],
  );
  const onImport = useCallback(
    (files: File[], point?: { x: number; y: number }) => {
      if (!board) return;
      const images = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
      if (!images.length) return setError('只能导入 PNG、JPEG、WebP 图片');
      void (async () => {
        for (const [i, file] of images.entries())
          await api(
            `boards/${board.id}/import${point ? `?x=${Math.round(point.x + i * 40)}&y=${Math.round(point.y + i * 40)}` : ''}`,
            { body: file },
          );
      })().catch(fail);
    },
    [board, fail],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (settings || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) onDelete(selected);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [selected, settings, onDelete]);

  const generate = async () => {
    if (!board || !site || !prompt.trim()) return;
    setError('');
    setRunning((n) => n + 1);
    const sent = prompt;
    try {
      const result = await api<{ errors: string[] }>('generate', {
        json: {
          prompt: sent,
          boardId: board.id,
          site: site.id,
          model: activeModel || undefined,
          aspectRatio: ratio || undefined,
          resolution: hd && resolution ? resolution : undefined,
          references,
          count,
        },
      });
      if (result.errors.length) setError(`部分图片生成失败：${result.errors[0]}`);
      setPrompt((current) => (current === sent ? '' : current));
    } catch (e) {
      fail(e);
    } finally {
      setRunning((n) => n - 1);
    }
  };
  const generateVideo = async () => {
    if (!board || !videoSite || !prompt.trim()) return;
    setError('');
    setRunning((n) => n + 1);
    const sent = prompt;
    try {
      let job = await api<VideoJob>('videos', {
        json: {
          prompt: sent,
          boardId: board.id,
          site: videoSite.id,
          model: activeVideoModel || undefined,
          image: startFrame,
          duration: duration ? Number(duration) : undefined,
          resolution: videoResolution || undefined,
          aspectRatio: !startFrame && ratio ? ratio : undefined,
        },
      });
      setPrompt((current) => (current === sent ? '' : current));
      // The job runs in the canvas service; this only waits to report a failure.
      while (job.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        job = await api<VideoJob>(`videos/${job.id}`);
      }
      if (job.status === 'failed') setError(job.error || '视频生成失败');
    } catch (e) {
      fail(e);
    } finally {
      setRunning((n) => n - 1);
    }
  };
  const submit = () => void (videoMode ? generateVideo() : generate());
  const boardAction = (work: () => Promise<unknown>) => void work().catch(fail);
  const waitingVideos = board?.pending.filter((p) => p.kind === 'video').length || 0;

  if (locked)
    return (
      <main className="gate">
        <h1>需要从 agent 中打开画布</h1>
        <p>
          这个页面只对本机授权的浏览器开放。请在 agent 里说“打开画布”，或在终端运行
          <code>npx hrouter-canvas-mcp open</code>。
        </p>
      </main>
    );
  if (!state || !board)
    return (
      <main className="gate">
        <p>{offline ? '画布服务未运行。请在 agent 中重新打开画布。' : '正在加载画布…'}</p>
      </main>
    );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={22} height={22} />
          <strong>HRouter Canvas</strong>
        </div>
        <select
          className="board-select"
          aria-label="切换画布"
          value={board.id}
          onChange={(e) =>
            boardAction(() => api(`boards/${e.target.value}/select`, { method: 'POST' }))
          }
        >
          {state.boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}（{b.count}）
            </option>
          ))}
        </select>
        <button
          className="ghost"
          title="重命名当前画布"
          onClick={() => {
            const title = window.prompt('画布名称', board.title);
            if (title?.trim()) patch({ title });
          }}
        >
          重命名
        </button>
        <button
          className="ghost"
          onClick={() => boardAction(() => api('boards', { json: { title: '新的画布' } }))}
        >
          <Plus size={14} /> 新建画布
        </button>
        <button
          className="ghost"
          title="删除当前画布"
          aria-label="删除当前画布"
          onClick={() => {
            if (confirm(`删除画布“${board.title}”和其中 ${board.images.length} 张图片？此操作不可恢复。`))
              boardAction(() => api(`boards/${board.id}`, { method: 'DELETE' }));
          }}
        >
          <Trash2 size={14} />
        </button>
        <span className="spacer" />
        {offline && <span className="offline">连接已断开，正在重连…</span>}
        <button className="ghost" onClick={() => fileInput.current?.click()}>
          <ImagePlus size={14} /> 导入图片
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            onImport(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        <button className="ghost" onClick={() => setSettings(true)}>
          <Cog size={14} /> 站点设置
        </button>
        <button
          className="icon-button"
          onClick={() => setDark(!dark)}
          aria-label={dark ? '切换到浅色' : '切换到深色'}
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </header>

      <main className="stage">
        <Canvas
          board={board}
          dark={dark}
          references={references}
          onEdges={onEdges}
          onSelect={onSelect}
          onPositions={onPositions}
          onViewport={onViewport}
          onReference={onReference}
          onVideo={onVideo}
          onFrame={onFrame}
          onDelete={onDelete}
          onImport={onImport}
        />
        {waiting > 0 && (
          <div className="generation-status" role="status">
            <Loader2 size={14} className="spin" />
            正在生成{' '}
            {[
              waiting - waitingVideos && `${waiting - waitingVideos} 张`,
              waitingVideos && `${waitingVideos} 个视频`,
            ]
              .filter(Boolean)
              .join('、')}{' '}
            · {board.pending[0].model} ·{' '}
            {Math.max(0, Math.round((now - Math.min(...board.pending.map((p) => p.startedAt))) / 1000))} 秒
          </div>
        )}

        <section className="composer" aria-label="生成图片">
          {error && (
            <p className="notice bad" role="alert">
              {error}
              <button className="icon-button" onClick={() => setError('')} aria-label="关闭提示">
                <X size={13} />
              </button>
            </p>
          )}
          {!ready ? (
            <div className="setup">
              <p>
                {videoMode
                  ? '还没有可用的生视频站点。在站点设置的“生视频站点”里填写 API Key（HRouter 视频预设已带 grok 模型，需要 grok 分组的 Key）。'
                  : '还没有可用的生图站点。填写站点地址和 API Key 后，agent 和这里都可以生图。'}
              </p>
              <button className="primary" onClick={() => setSettings(true)}>
                去配置站点
              </button>
              {videoMode && (
                <button className="ghost" onClick={() => setMode('image')}>
                  返回生图
                </button>
              )}
            </div>
          ) : (
            <>
              {references.length > 0 && (
                <div className="refs">
                  <span>{videoMode ? (continuing ? '接着这段视频' : '首帧') : '参考图'}</span>
                  {(videoMode ? references.slice(0, 1) : references).map((id) => (
                    <button key={id} onClick={() => onReference(id)} title={videoMode ? '移除首帧' : '移除参考图'}>
                      {board.images.some((i) => i.id === id && isVideo(i)) ? (
                        <video src={imageUrl(board.id, id)} muted preload="metadata" />
                      ) : (
                        <img src={imageUrl(board.id, id)} alt="" />
                      )}
                      <X size={10} />
                    </button>
                  ))}
                  {videoMode && references.length > 1 && <small>视频只用第一张作为首帧</small>}
                </div>
              )}
              <textarea
                value={prompt}
                rows={2}
                maxLength={8000}
                placeholder={
                  videoMode
                    ? continuing
                      ? '从这段视频的最后一帧接着生成：描述接下来发生什么…'
                      : startFrame
                      ? '描述画面怎么动：动作、镜头运动、节奏…'
                      : '描述视频内容；也可以先在图片上点“生成视频”用它做首帧'
                    : references.length
                      ? '描述要怎么修改或参考这些图片…'
                      : '描述你想要的画面…（⌘/Ctrl + Enter 生成）'
                }
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
              <div className="controls">
                <div className="mode-switch" role="group" aria-label="生成类型">
                  <button aria-pressed={!videoMode} onClick={() => setMode('image')}>
                    <ImagePlus size={13} /> 图片
                  </button>
                  <button aria-pressed={videoMode} onClick={() => setMode('video')}>
                    <Clapperboard size={13} /> 视频
                  </button>
                </div>
                {videoMode && videoSite ? (
                  <>
                    <select aria-label="站点" value={videoSite.id} onChange={(e) => setVideoSiteId(e.target.value)}>
                      {videoSites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <select aria-label="模型" value={activeVideoModel} onChange={(e) => setVideoModel(e.target.value)}>
                      {videoSite.models.map((id) => (
                        <option key={id}>{id}</option>
                      ))}
                    </select>
                    <select aria-label="时长" value={duration} onChange={(e) => setDuration(e.target.value)}>
                      {DURATIONS.map((d) => (
                        <option key={d} value={d}>
                          {d ? `${d} 秒` : '时长默认'}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="分辨率"
                      value={videoResolution}
                      onChange={(e) => setVideoResolution(e.target.value)}
                    >
                      {VIDEO_RESOLUTIONS.map((r) => (
                        <option key={r} value={r}>
                          {r || '分辨率默认'}
                        </option>
                      ))}
                    </select>
                    {!startFrame && (
                      <select aria-label="画面比例" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                        {RATIOS.map((r) => (
                          <option key={r} value={r}>
                            {r || '比例自动'}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                ) : (
                  site && (
                    <>
                      <select aria-label="站点" value={site.id} onChange={(e) => setSiteId(e.target.value)}>
                        {usable.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      <select aria-label="模型" value={activeModel} onChange={(e) => setModel(e.target.value)}>
                        {!site.models.length && <option value="">未配置模型</option>}
                        {site.models.map((id) => (
                          <option key={id}>{id}</option>
                        ))}
                      </select>
                      <select aria-label="画面比例" value={ratio} onChange={(e) => setRatio(e.target.value)}>
                        {RATIOS.map((r) => (
                          <option key={r} value={r}>
                            {r || '比例自动'}
                          </option>
                        ))}
                      </select>
                      {hd && (
                        <select
                          aria-label="分辨率"
                          value={resolution}
                          onChange={(e) => setResolution(e.target.value)}
                        >
                          <option value="">分辨率默认</option>
                          <option>1K</option>
                          <option>2K</option>
                          <option>4K</option>
                        </select>
                      )}
                      <select aria-label="数量" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                        {[1, 2, 3, 4].map((n) => (
                          <option key={n} value={n}>
                            {n} 张
                          </option>
                        ))}
                      </select>
                    </>
                  )
                )}
                <span className="spacer" />
                <button
                  className="primary"
                  disabled={!prompt.trim() || !(videoMode ? activeVideoModel : activeModel)}
                  onClick={submit}
                >
                  {running ? <Loader2 size={14} className="spin" /> : videoMode ? <Clapperboard size={14} /> : <Sparkles size={14} />}
                  {videoMode ? '生成视频' : '生成'}
                </button>
              </div>
            </>
          )}
        </section>
      </main>
      {settings && <Settings state={state} onClose={() => setSettings(false)} />}
    </div>
  );
}
