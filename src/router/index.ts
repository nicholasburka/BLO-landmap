import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import { clearInternalSession, useAuth } from '@/composables/useAuth'
import { setSessionExpiredHandler } from '@/lib/apiBase'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
    },
    {
      path: '/about',
      name: 'about',
      // route level code-splitting
      // this generates a separate chunk (About.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import('../views/AboutView.vue')
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue')
    },
    {
      path: '/account',
      name: 'account',
      component: () => import('../views/AccountView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-8: add something — a link, a document, or a folder of them. Lazy
      // and internal-only like the rest of the knowledge base; the public
      // map's bundle must not grow a drop page.
      path: '/new',
      name: 'new',
      component: () => import('../views/NewView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // UX pass: knowledge-base front door (replaces the Library + Wiki nav links).
      path: '/kb',
      name: 'knowledge-base',
      component: () => import('../views/KnowledgeBaseView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-41's answer page grew into Chat (P6-7). Guarded, so a shared
      // `/ask?q=…` link still bounces a logged-out reader through login
      // before it lands.
      path: '/ask',
      name: 'ask',
      component: () => import('../views/RetiredRedirect.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-7b: a conversation with the library's own tools. Lazy and
      // internal-only like /ask — the public map's bundle must not grow a
      // chat page, and none of its strings may reach the public build.
      path: '/chat',
      name: 'chat',
      component: () => import('../views/ChatView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-45's layers index is the datasets browser now (P6-3): public
      // layers are rows in it like anything else. `/layers/:id` below is
      // untouched — a layer's about page is where it always was.
      path: '/layers',
      name: 'layers',
      component: () => import('../views/RetiredRedirect.vue'),
      meta: { requiresInternal: true }
    },
    {
      // `/layers/internal-<slug>` redirects to the library entry from inside
      // the view (it already knows the id shape) — that entry hub has the
      // About / Data / Map tabs an internal layer needs.
      path: '/layers/:id',
      name: 'layer-about',
      component: () => import('../views/LayerAboutView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-55: a handful of candidate counties, side by side, across the
      // layers that matter. Lazy and internal-only like the rest of the
      // knowledge base — the public map's bundle must not grow a page.
      path: '/compare',
      name: 'compare',
      component: () => import('../views/CompareView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-3: every dataset-shaped thing in one list — held tables, indexed
      // sources and the map's layers — grouped by publisher, subject or type.
      // Lazy and internal-only: the public map's bundle must not grow a
      // knowledge-base page, and none of its words may reach the public build.
      path: '/datasets',
      name: 'datasets',
      component: () => import('../views/DatasetsView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-4: pages, documents, notes and the to-file queue.
      path: '/docs',
      name: 'docs',
      component: () => import('../views/DocsView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-4: the four tools, and the saved views and cached place reports
      // they have already produced.
      path: '/analysis',
      name: 'analysis',
      component: () => import('../views/AnalysisView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-58: one address, every data source that covers it. Lazy and
      // internal-only like the rest of the knowledge base — the public map's
      // bundle must not grow a report page.
      path: '/place',
      name: 'place',
      component: () => import('../views/PlaceView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-6: one box across every resource, grouped held-first, with the
      // filters as URL keys so a search is a link. Lazy and internal-only —
      // the public map's bundle must not grow a knowledge-base page.
      path: '/search',
      name: 'search',
      component: () => import('../views/SearchView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P6-5: the Library list is three browsers now. Where a given link goes
      // depends on what it asked for — see `lib/retiredRoutes`. Entry pages
      // (`/library/:slug`, below) are untouched.
      path: '/library',
      name: 'library',
      component: () => import('../views/RetiredRedirect.vue'),
      meta: { requiresInternal: true }
    },
    {
      path: '/library/:slug',
      name: 'library-entry',
      component: () => import('../views/LibraryEntryView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-37: the table now lives on the entry hub's Data tab; old links
      // (wiki pages, bookmarks) redirect there with their table state intact.
      path: '/library/:slug/data',
      name: 'library-data',
      redirect: to => ({ path: `/library/${String(to.params.slug)}`, query: { ...to.query, tab: 'data' } }),
      meta: { requiresInternal: true }
    },
    {
      // P6-5: pages are one kind of doc, so the pages index is `/docs?kind=wiki`.
      // `/wiki/:slug` (below) is the page itself and does not move.
      path: '/wiki',
      name: 'wiki',
      component: () => import('../views/RetiredRedirect.vue'),
      meta: { requiresInternal: true }
    },
    {
      path: '/wiki/:slug',
      name: 'wiki-page',
      component: () => import('../views/WikiPageView.vue'),
      meta: { requiresInternal: true }
    },
    {
      // P5-16 shim: guarded entry point for shared view links. Redirects to
      // /?view=<slug> (the map watches that query param) after the internal
      // guard has had its chance to bounce logged-out users to /login.
      path: '/views/:slug',
      name: 'view-open',
      component: () => import('../views/ViewRedirect.vue'),
      meta: { requiresInternal: true }
    }
  ]
})

// Internal-route guard (phase 5). Awaits boot hydration so a direct load
// of a guarded URL (cookie present, /api/me still in flight) doesn't
// bounce a logged-in user to /login.
router.beforeEach(async to => {
  if (!to.meta.requiresInternal) return true
  const { internalUser, internalAuthReady } = useAuth()
  await internalAuthReady
  if (internalUser.value) return true
  return { name: 'login', query: { redirect: to.fullPath } }
})

// A session that expires under an open page (P5-72). apiBase spots the 401
// and decides whether it means anything; here is the only place that can act
// on it — this module has the session and the history. The login page's
// `?redirect=` brings the person back to what they were reading.
setSessionExpiredHandler(loginPath => {
  clearInternalSession()
  void router.replace(loginPath)
})

export default router
