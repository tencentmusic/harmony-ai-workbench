"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { reviewSections } from './review-sections'
import { ReviewData } from './ReviewData'
import { activeReviewSection, reviewScrollTarget } from './review-scroll'
import styles from './HarnessReview.module.css'

export function ReviewDocument({ content, attachments, visuals, scrollRoot, hideNavigation = false }: { content: string; attachments: ReactNode; visuals?: ReactNode; scrollRoot: RefObject<HTMLDivElement | null>; hideNavigation?: boolean }) {
  const hasVisuals = !!visuals
  const sections = useMemo(() => [...(hasVisuals ? [{ id: 'review-visuals', label: 'UI 原型对照', content: '' }] : []), ...reviewSections(content), { id: 'review-attachments', label: '审核附件', content: '' }], [content, hasVisuals])
  const [active, setActive] = useState(sections[0].id)
  const viewport = useRef<HTMLDivElement>(null)
  const navigation = useRef<HTMLElement>(null)
  function stickyHeight(root: HTMLElement) {
    const toolbar = root.querySelector<HTMLElement>('[data-task-toolbar]')?.offsetHeight || 0
    const nav = navigation.current
    return toolbar + (nav && !nav.hidden && getComputedStyle(nav).display === 'flex' ? nav.offsetHeight : 0)
  }
  useEffect(() => {
    const root = scrollRoot.current, document = viewport.current
    if (!root || !document) return
    let frame = 0
    const update = () => {
      frame = 0
      const top = root.getBoundingClientRect().top
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-review-section]')).map(item => ({ id: item.id, top: item.getBoundingClientRect().top }))
      const toolbarHeight = stickyHeight(root)
      const current = activeReviewSection(items, top, toolbarHeight, root.scrollHeight > root.clientHeight && root.scrollTop + root.clientHeight >= root.scrollHeight - 3)
      if (current) setActive(current)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    root.addEventListener('scroll', schedule, { passive: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(root)
    resize.observe(document)
    const toolbar = root.querySelector<HTMLElement>('[data-task-toolbar]')
    if (toolbar) resize.observe(toolbar)
    if (navigation.current) resize.observe(navigation.current)
    schedule()
    return () => { root.removeEventListener('scroll', schedule); resize.disconnect(); cancelAnimationFrame(frame) }
  }, [sections, scrollRoot, hideNavigation])
  useEffect(() => {
    const root = navigation.current, button = root?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!root || !button) return
    const bounds = root.getBoundingClientRect(), item = button.getBoundingClientRect()
    if (item.top < bounds.top || item.bottom > bounds.bottom) root.scrollTop += item.top - bounds.top
    if (item.left < bounds.left || item.right > bounds.right) root.scrollLeft += item.left - bounds.left
  }, [active])
  function jump(id: string) {
    const root = scrollRoot.current, element = viewport.current?.querySelector<HTMLElement>(`#${id}`)
    if (root && element) {
      const toolbarHeight = stickyHeight(root)
      root.scrollTo({ top: reviewScrollTarget(root.scrollTop, element.getBoundingClientRect().top, root.getBoundingClientRect().top, toolbarHeight), behavior: 'instant' })
      setActive(id)
    }
  }
  return <div className={`${styles.layout} ${hideNavigation ? styles.expanded : ''}`}>
    <nav ref={navigation} hidden={hideNavigation} className={styles.navigation} aria-label="审核章节">
      {sections.map((section, index) => <button type="button" key={section.id} aria-current={active === section.id ? 'location' : undefined} aria-controls={section.id} onClick={() => jump(section.id)}>
        <span className={styles.number}>{String(index + 1).padStart(2, '0')}</span><span>{section.label}</span>
      </button>)}
    </nav>
    <div ref={viewport} className={styles.viewport} role="region" aria-label="审核正文" tabIndex={0}>
      {sections.map(section => <section id={section.id} data-review-section key={section.id} className={styles.section}>
        {section.id === 'review-visuals' ? <><h2>UI 原型对照</h2>{visuals}</> : section.id === 'review-attachments' ? <><h2>审核附件</h2>{attachments}</> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          img: () => <span className={styles.imageReference}>［图片见审核附件］</span>,
          a: ({ children }) => <span>{children}</span>,
          table: ({ children }) => <div className={styles.table}><table>{children}</table></div>,
          pre: ({ children }) => <ReviewData>{children}</ReviewData>,
        }}>{section.content}</ReactMarkdown>}
      </section>)}
    </div>
  </div>
}
