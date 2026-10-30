/** Default documentation theme with client-side filtering for long Markdown tables. */
import DefaultTheme from 'vitepress/theme'
import { getScrollOffset, onContentUpdated, useData, type Theme } from 'vitepress'
import { defineComponent, h, onBeforeUnmount, onMounted } from 'vue'
import { DocumentTables } from './table-filter.ts'
import './table-filter.css'

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    name: 'DocsLayout',
    setup() {
      const { lang } = useData()
      let tables: DocumentTables | undefined
      let initialScroll: number | undefined
      onMounted(() => {
        tables = new DocumentTables(document, () => lang.value)
        // VitePress computes the initial hash position before hydration inserts table controls.
        const anchor = document.querySelector(':target')
        if (anchor) initialScroll = window.requestAnimationFrame(() => {
          initialScroll = undefined
          if (!anchor.isConnected) return
          const top = window.scrollY + anchor.getBoundingClientRect().top - getScrollOffset()
          window.scrollTo(0, top + parseFloat(window.getComputedStyle(anchor).paddingTop))
        })
      })
      onContentUpdated(() => { tables?.refresh() })
      onBeforeUnmount(() => {
        if (initialScroll !== undefined) window.cancelAnimationFrame(initialScroll)
        tables?.dispose()
        tables = undefined
      })
      return () => h(DefaultTheme.Layout)
    },
  }),
} satisfies Theme
