import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
  type Viewport,
} from '@xyflow/react';
import { ArrowDownToLine, Clapperboard, ImagePlus, Play, Scan, Scissors, Trash2 } from 'lucide-react';
import { imageUrl, isVideo, type Board, type CanvasImage } from './api';
import '@xyflow/react/dist/style.css';

type ImageNode = Node<
  {
    image: CanvasImage;
    boardId: string;
    referenced: boolean;
    onReference: (id: string) => void;
    onVideo: (id: string) => void;
    onFrame: (id: string, at: 'first' | 'last' | number) => void;
    onDelete: (ids: string[]) => void;
  },
  'image'
>;
const FRAME_AT: Record<string, string> = { first: '第一帧', last: '最后一帧' };
const ImageCard = memo(function ImageCard({ data, selected }: NodeProps<ImageNode>) {
  const { image, boardId } = data;
  const video = isVideo(image);
  const style = { width: '100%', aspectRatio: `${image.width}/${image.height}` };
  const player = useRef<HTMLVideoElement>(null);
  const label =
    image.kind === 'generated'
      ? image.model
      : image.frame
        ? `视频帧 · ${FRAME_AT[image.frame.at] || `${image.frame.at} 秒`}`
        : '参考图';
  // Hovering plays the preview; leaving pauses it, so the frame on screen is the one captured.
  const capture = () => {
    const at = player.current?.currentTime || 0;
    data.onFrame(image.id, at < 0.05 ? 'first' : Math.round(at * 100) / 100);
  };
  return (
    <div className={`image-node ${selected ? 'selected' : ''} ${data.referenced ? 'referenced' : ''}`}>
      <Handle type="target" position={Position.Left} aria-label="输入连接点" />
      <Handle type="source" position={Position.Right} aria-label="输出连接点" />
      {video ? (
        // Muted previews play on hover so the node stays draggable; the toolbar opens a full player.
        <video
          ref={player}
          src={imageUrl(boardId, image.id)}
          title={image.prompt || undefined}
          muted
          loop
          playsInline
          preload="metadata"
          style={style}
          onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
          onMouseLeave={(e) => e.currentTarget.pause()}
        />
      ) : (
        <img
          src={imageUrl(boardId, image.id)}
          alt={image.prompt || '导入的参考图片'}
          title={image.prompt || undefined}
          draggable={false}
          loading="lazy"
          style={style}
        />
      )}
      <div className="image-dimensions" title={video ? '视频实际尺寸和时长' : '原始图片实际尺寸，下载不缩放'}>
        {image.width}×{image.height}
        {video && image.duration ? ` · ${image.duration}s` : ''}
        {image.source === 'agent' && image.kind === 'generated' && <span> · Agent</span>}
      </div>
      <div className="node-toolbar nodrag nopan">
        <span>{label}</span>
        {video ? (
          <>
            <a title="在新标签页播放" aria-label="在新标签页播放" href={imageUrl(boardId, image.id)} target="_blank" rel="noreferrer">
              <Play size={14} />
            </a>
            <button title="截取当前画面为图片" aria-label="截取当前画面为图片" onClick={capture}>
              <Scissors size={14} />
            </button>
            <button title="从结尾继续生成视频" aria-label="从结尾继续生成视频" onClick={() => data.onVideo(image.id)}>
              <Clapperboard size={14} />
            </button>
          </>
        ) : (
          <>
            <button
              title={data.referenced ? '取消参考' : '用作参考图'}
              aria-label={data.referenced ? '取消参考' : '用作参考图'}
              aria-pressed={data.referenced}
              onClick={() => data.onReference(image.id)}
            >
              <ImagePlus size={14} />
            </button>
            <button title="用这张图生成视频" aria-label="用这张图生成视频" onClick={() => data.onVideo(image.id)}>
              <Clapperboard size={14} />
            </button>
          </>
        )}
        <a
          title={video ? '下载视频' : '下载原图'}
          aria-label={video ? '下载视频' : '下载原图'}
          href={imageUrl(boardId, image.id, true)}
        >
          <ArrowDownToLine size={14} />
        </a>
        <button
          title={video ? '删除视频' : '删除图片'}
          aria-label={video ? '删除视频' : '删除图片'}
          onClick={() => data.onDelete([image.id])}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
});
const nodeTypes = { image: ImageCard };

interface Props {
  board: Board;
  dark: boolean;
  references: string[];
  onEdges: (edges: Array<{ id?: string; source: string; target: string }>) => void;
  onSelect: (ids: string[]) => void;
  onPositions: (positions: Array<{ id: string; x: number; y: number }>) => void;
  onViewport: (viewport: Viewport) => void;
  onReference: (id: string) => void;
  onVideo: (id: string) => void;
  onFrame: (id: string, at: 'first' | 'last' | number) => void;
  onDelete: (ids: string[]) => void;
  onImport: (files: File[], point?: { x: number; y: number }) => void;
}
function CanvasInner(props: Props) {
  const { board, references, onSelect, onPositions, onViewport, onReference, onVideo, onFrame, onDelete, onImport } =
    props;
  const [nodes, setNodes, onNodesChange] = useNodesState<ImageNode>([]);
  const flow = useReactFlow<ImageNode>();
  const dragging = useRef(false);
  const known = useRef(new Set<string>());
  useEffect(() => {
    // A refresh that lands mid-drag would snap the node back; the drop saves and resyncs anyway.
    if (dragging.current) return;
    setNodes((current) => {
      const selected = new Set(current.filter((n) => n.selected).map((n) => n.id));
      return board.images.map((image) => ({
        id: image.id,
        type: 'image' as const,
        position: { x: image.x, y: image.y },
        style: { width: image.displayWidth },
        selected: selected.has(image.id),
        data: {
          image,
          boardId: board.id,
          referenced: references.includes(image.id),
          onReference,
          onVideo,
          onFrame,
          onDelete,
        },
      }));
    });
  }, [board.id, board.images, references, onReference, onVideo, onFrame, onDelete, setNodes]);
  // Bring a freshly generated image into view, since it may land outside the current viewport.
  useEffect(() => {
    const fresh = board.images.filter((i) => !known.current.has(i.id));
    const first = known.current.size === 0;
    known.current = new Set(board.images.map((i) => i.id));
    if (!fresh.length || (first && (board.viewport.x || board.viewport.y || board.viewport.zoom !== 1)))
      return;
    const timer = setTimeout(
      () =>
        void flow.fitView({
          nodes: first ? undefined : fresh.map((i) => ({ id: i.id })),
          padding: first ? 0.18 : 0.6,
          duration: 300,
          maxZoom: 1,
        }),
      80,
    );
    return () => clearTimeout(timer);
  }, [board.id, board.images, board.viewport, flow]);
  // React Flow re-syncs its store whenever these props change identity, and a selection callback
  // that sets state on every sync would loop. Keep both stable.
  const edges = useMemo(
    () =>
      board.edges.map((edge) => ({
        ...edge,
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#9d94b7', strokeWidth: 1.5 },
      })),
    [board.edges],
  );
  const selectionChanged = useCallback(
    ({ nodes: selected }: { nodes: ImageNode[] }) => onSelect(selected.map((n) => n.id)),
    [onSelect],
  );
  const savePositions = useCallback(() => {
    dragging.current = false;
    onPositions(flow.getNodes().map((n) => ({ id: n.id, ...n.position })));
  }, [flow, onPositions]);
  return (
    <div
      className="canvas-surface"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        onImport(
          Array.from(e.dataTransfer.files),
          flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        );
      }}
    >
      <ReactFlow<ImageNode>
        key={board.id}
        nodes={nodes}
        edges={edges}
        onConnect={(c) => props.onEdges([...board.edges, { source: c.source, target: c.target }])}
        onEdgeDoubleClick={(_e, edge) => props.onEdges(board.edges.filter((e) => e.id !== edge.id))}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={board.viewport}
        onNodeDragStart={() => (dragging.current = true)}
        onNodeDragStop={savePositions}
        onSelectionDragStart={() => (dragging.current = true)}
        onSelectionDragStop={savePositions}
        onMoveEnd={(_e, viewport) => onViewport(viewport)}
        onSelectionChange={selectionChanged}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        minZoom={0.05}
        maxZoom={4}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        deleteKeyCode={null}
        colorMode={props.dark ? 'dark' : 'light'}
        nodesConnectable
        isValidConnection={(c) =>
          c.source !== c.target &&
          !board.edges.some((e) => e.source === c.source && e.target === c.target)
        }
        selectNodesOnDrag
        attributionPosition="bottom-left"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color={props.dark ? '#393b47' : '#dedee7'}
        />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor="#a59ad8"
          maskColor={props.dark ? '#181920aa' : '#f7f7faaa'}
        />
      </ReactFlow>
      {!board.images.length && !board.pending.length && (
        <div className="canvas-welcome">
          <div className="canvas-welcome-mark">
            <ImagePlus size={33} />
          </div>
          <h2>让灵感，在这里展开。</h2>
          <p>在 agent 里说“帮我画……”“把这张图做成视频”，或在下方写下描述，也可以拖入图片</p>
          <span>无限画布 · 本机保存 · 文件可直接用于项目</span>
        </div>
      )}
      <button
        className="fit-button"
        onClick={() => void flow.fitView({ padding: 0.18, duration: 250 })}
        aria-label="查看全部图片"
      >
        <Scan size={15} />
        适应画布
      </button>
    </div>
  );
}
export default function Canvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
