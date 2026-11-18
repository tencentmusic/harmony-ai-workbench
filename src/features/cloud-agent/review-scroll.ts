const chapterGap = 12

export function reviewScrollTarget(scrollTop: number, sectionTop: number, rootTop: number, toolbarHeight: number) {
  return Math.max(0, scrollTop + sectionTop - rootTop - toolbarHeight - chapterGap)
}

export function activeReviewSection(sections: { id: string; top: number }[], rootTop: number, toolbarHeight: number, atEnd: boolean) {
  if (atEnd) return sections.at(-1)?.id
  let current = sections[0]?.id
  for (const section of sections) if (section.top <= rootTop + toolbarHeight + chapterGap + 1) current = section.id
  return current
}
