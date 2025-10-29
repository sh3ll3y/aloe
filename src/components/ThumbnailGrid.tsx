import { DndContext, DragEndEvent, DragStartEvent, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { RotationDirection } from '../utils/pdfUtils';
import type { CSSProperties } from 'react';
import React, { memo, useMemo, useState } from 'react';

export interface PageThumbnailData {
  id: string;
  /** 1-based page number for display. */
  pageNumber: number;
  /** Data URL representing the rendered page image. */
  previewUrl: string;
  /** Rotation in degrees applied to the page. */
  rotation: number;
  /** Hex/CSS color indicating the document group. */
  groupColor?: string;
}

interface ThumbnailGridProps {
  pages: PageThumbnailData[];
  onReorder: (sourceIndex: number, destinationIndex: number) => void;
  onRotate: (id: string, direction: RotationDirection) => void;
  onDelete: (id: string) => void;
}

/**
 * Displays draggable page thumbnails with quick actions.
 */
export function ThumbnailGrid({ pages, onReorder, onRotate, onDelete }: ThumbnailGridProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [activeId, setActiveId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      setActiveId(null);
      return;
    }
    const fromIndex = pages.findIndex((p) => p.id === String(active.id));
    const toIndex = pages.findIndex((p) => p.id === String(over.id));
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      setActiveId(null);
      return;
    }
    onReorder(fromIndex, toIndex);
    setActiveId(null);
  };

  const activePage = useMemo(() => pages.find((p) => p.id === activeId) || null, [pages, activeId]);

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
        <div className="flex flex-wrap content-start rounded-2xl border border-[var(--aloe-border)] bg-[var(--aloe-surface)] p-4 shadow-sm">
          {pages.map((page) => (
            <SortableItem key={page.id} page={page} onRotate={onRotate} onDelete={onDelete} />
          ))}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {activePage ? <SortableItemContent page={activePage} draggingOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

const SortableItem = memo(function SortableItem({ page, onRotate, onDelete }: { page: PageThumbnailData; onRotate: ThumbnailGridProps['onRotate']; onDelete: ThumbnailGridProps['onDelete'] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    willChange: 'transform',
    zIndex: isDragging ? 50 : 'auto',
    opacity: isDragging ? 0.2 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SortableItemContent page={page} withControls onRotate={onRotate} onDelete={onDelete} />
    </div>
  );
});

const SortableItemContent = memo(function SortableItemContent({ page, draggingOverlay = false, withControls = false, onRotate, onDelete }: { page: PageThumbnailData; draggingOverlay?: boolean; withControls?: boolean; onRotate?: ThumbnailGridProps['onRotate']; onDelete?: ThumbnailGridProps['onDelete'] }) {
  const baseClasses =
    'm-2 box-border flex w-32 flex-col items-center gap-2 rounded-xl border border-[var(--aloe-border)] bg-[var(--aloe-surface-muted)] p-2 text-center shadow-sm transition will-change-transform';
  const activeClasses = draggingOverlay ? ' border-[var(--aloe-accent)] shadow-xl z-50' : '';
  const containerStyle: CSSProperties = { pointerEvents: 'none', borderColor: page.groupColor };
  return (
    <div className={`${baseClasses}${activeClasses}`} style={containerStyle}>
      <div className="relative h-36 w-full overflow-hidden rounded-lg bg-[var(--aloe-accent-soft)]">
        <img src={page.previewUrl} alt={`Page ${page.pageNumber}`} style={{ transform: `rotate(${page.rotation}deg)` }} className="h-full w-full object-contain" />
      </div>
      <span className="text-xs font-semibold text-[var(--aloe-text-secondary)]">Page {page.pageNumber}</span>
      {withControls && onRotate && onDelete ? (
        <div className="flex items-center gap-2" style={{ pointerEvents: 'auto' }}>
          <button
            type="button"
            aria-label="Rotate counterclockwise"
            title="Rotate counterclockwise"
            className="rounded-full bg-[var(--aloe-primary-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-border)]"
            onClick={(e) => { e.stopPropagation(); onRotate(page.id, 'counterclockwise'); }}
          >
            ⟲
          </button>
          <button
            type="button"
            aria-label="Rotate clockwise"
            title="Rotate clockwise"
            className="rounded-full bg-[var(--aloe-primary-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--aloe-text-secondary)] transition hover:bg-[var(--aloe-border)]"
            onClick={(e) => { e.stopPropagation(); onRotate(page.id, 'clockwise'); }}
          >
            ⟳
          </button>
          <button
            type="button"
            aria-label="Delete page"
            title="Delete page"
            className="rounded-full bg-[var(--aloe-danger)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--aloe-danger-strong)]"
            onClick={(e) => { e.stopPropagation(); onDelete(page.id); }}
          >
            ✖
          </button>
        </div>
      ) : null}
    </div>
  );
});
