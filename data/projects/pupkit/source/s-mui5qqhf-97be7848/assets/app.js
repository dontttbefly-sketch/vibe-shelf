// 数据模型
const products = [
  {
    id: "loop",
    name: "Loop Squeak Mini",
    price: 18,
    description: "小环、低声、软韧。",
    toy: "toy-loop",
    colors: ["#ff6348", "#ffe16a"],
    badge: "入门",
    chew: "2级",
    fit: "1-12kg",
    clean: "冲洗",
    principles: ["客厅互动", "低音反馈", "轻量咬感"],
    playTitle: "客厅拉扯短片",
    playCopy: "小环把互动变轻。",
    playSteps: ["握住外侧。", "短拉短停。", "咀嚼收尾。"],
    tags: ["chew", "quiet", "starter", "under5", "five12", "gift"]
  },
  {
    id: "ufo",
    name: "Kibble UFO",
    price: 22,
    description: "零食变慢，鼻子变忙。",
    toy: "toy-ufo",
    colors: ["#55b8d6", "#2f7b5f"],
    badge: "鼻工",
    chew: "1级",
    fit: "1-8kg",
    clean: "水洗",
    principles: ["慢食", "鼻工", "雨天"],
    playTitle: "零食轨道短片",
    playCopy: "食物变成一段小任务。",
    playSteps: ["少量投食。", "鼻尖探索。", "安静结束。"],
    tags: ["puzzle", "starter", "under5", "washable"]
  },
  {
    id: "dash",
    name: "Dash Dot Ball",
    price: 14,
    description: "亮色、轻弹、好带回。",
    toy: "toy-bounce",
    colors: ["#222b2f", "#f6cc3f"],
    badge: "追逐",
    chew: "2级",
    fit: "5-12kg",
    clean: "冲洗",
    principles: ["轻弹", "高可见", "短追"],
    playTitle: "走廊短抛短片",
    playCopy: "速度有目标。",
    playSteps: ["低位抛出。", "短距追逐。", "带回奖励。"],
    tags: ["fetch", "five12", "washable"]
  },
  {
    id: "calm",
    name: "Calm Knot",
    price: 16,
    description: "低声绳结，安静陪伴。",
    toy: "toy-knot",
    colors: ["#8875e6", "#fbf7ed"],
    badge: "低噪",
    chew: "1级",
    fit: "1-10kg",
    clean: "手洗",
    principles: ["低声", "睡前", "柔咬"],
    playTitle: "夜间陪伴短片",
    playCopy: "安静也是玩耍。",
    playSteps: ["递到嘴边。", "轻咬放松。", "回到玩具篮。"],
    tags: ["quiet", "under5", "five12", "starter", "gift"]
  },
  {
    id: "bone",
    name: "Pocket Bone",
    price: 19,
    description: "短骨入口，认真咀嚼。",
    toy: "toy-bone",
    colors: ["#ce7b51", "#fbf7ed"],
    badge: "耐咬",
    chew: "3级",
    fit: "3-12kg",
    clean: "冲洗",
    principles: ["短骨", "硬韧", "专注"],
    playTitle: "咀嚼专注短片",
    playCopy: "力量落在咬感里。",
    playSteps: ["短时开咬。", "翻面换角。", "检查边缘。"],
    tags: ["chew", "five12", "washable"]
  },
  {
    id: "tug",
    name: "Tug Token Duo",
    price: 24,
    description: "双件拉扯，互动轮换。",
    toy: "toy-loop",
    colors: ["#2f7b5f", "#55b8d6"],
    badge: "双件",
    chew: "2级",
    fit: "1-12kg",
    clean: "冲洗",
    principles: ["双件", "轮换", "拉扯"],
    playTitle: "双环轮换短片",
    playCopy: "互动有节拍。",
    playSteps: ["第一只升温。", "第二只接力。", "节奏回落。"],
    tags: ["chew", "starter", "gift", "under5", "five12"]
  },
  {
    id: "sniff",
    name: "Sniff Capsule",
    price: 21,
    description: "慢食胶囊，安静鼻工。",
    toy: "toy-ufo",
    colors: ["#f2553c", "#55b8d6"],
    badge: "慢食",
    chew: "1级",
    fit: "1-8kg",
    clean: "水洗",
    principles: ["慢食", "胶囊", "低兴奋"],
    playTitle: "胶囊鼻工短片",
    playCopy: "鼻子接管兴奋。",
    playSteps: ["少量填入。", "滚动寻找。", "慢食收束。"],
    tags: ["puzzle", "quiet", "under5", "washable"]
  },
  {
    id: "glow",
    name: "Glow Pebble",
    price: 15,
    description: "傍晚可见，轻弹好叼。",
    toy: "toy-bounce",
    colors: ["#f6cc3f", "#8875e6"],
    badge: "夜光",
    chew: "2级",
    fit: "1-12kg",
    clean: "冲洗",
    principles: ["傍晚", "轻弹", "好叼"],
    playTitle: "傍晚召回短片",
    playCopy: "光点把距离拉近。",
    playSteps: ["亮点吸引。", "短线召回。", "轻弹复玩。"],
    tags: ["fetch", "gift", "under5", "five12"]
  },
  {
    id: "maze",
    name: "Mini Treat Maze",
    price: 26,
    description: "迷宫慢食，专注更长。",
    toy: "toy-ufo",
    colors: ["#ffe16a", "#2b775f"],
    badge: "迷宫",
    chew: "1级",
    fit: "1-10kg",
    clean: "水洗",
    principles: ["慢食", "专注", "可拆"],
    playTitle: "迷宫慢食短片",
    playCopy: "零食绕远，节奏变稳。",
    playSteps: ["铺开零食。", "鼻尖找路。", "拆洗归位。"],
    tags: ["puzzle", "starter", "washable", "under5", "five12"]
  },
  {
    id: "ripple",
    name: "Ripple Tug Mini",
    price: 20,
    description: "波纹手感，拉扯有弹。",
    toy: "toy-loop",
    colors: ["#4eb5d8", "#ff6348"],
    badge: "拉扯",
    chew: "2级",
    fit: "1-12kg",
    clean: "冲洗",
    principles: ["波纹", "回弹", "抓握"],
    playTitle: "波纹拉扯短片",
    playCopy: "回弹让互动更轻。",
    playSteps: ["握住波纹。", "侧向拉扯。", "停顿复位。"],
    tags: ["chew", "starter", "under5", "five12"]
  },
  {
    id: "cloud",
    name: "Quiet Cloud Puff",
    price: 17,
    description: "柔软云朵，低声抱玩。",
    toy: "toy-knot",
    colors: ["#fbf7ed", "#8875e6"],
    badge: "柔软",
    chew: "1级",
    fit: "1-8kg",
    clean: "手洗",
    principles: ["抱玩", "低声", "柔软"],
    playTitle: "云朵抱玩短片",
    playCopy: "柔软保留陪伴感。",
    playSteps: ["轻轻递出。", "抱咬放松。", "安静归位。"],
    tags: ["quiet", "gift", "under5"]
  },
  {
    id: "disc",
    name: "Pup Pop Disc",
    price: 18,
    description: "小飞盘，轻抛好接。",
    toy: "toy-bounce",
    colors: ["#ff6348", "#4eb5d8"],
    badge: "飞盘",
    chew: "2级",
    fit: "3-12kg",
    clean: "冲洗",
    principles: ["轻抛", "低弧", "明亮"],
    playTitle: "低弧飞盘短片",
    playCopy: "飞盘也可以很小。",
    playSteps: ["低弧抛出。", "短距接回。", "水洗收纳。"],
    tags: ["fetch", "gift", "five12", "washable"]
  },
  {
    id: "bento",
    name: "Bento Bone Mini",
    price: 23,
    description: "便当短骨，香味停留。",
    toy: "toy-bone",
    colors: ["#ce7b51", "#ffe16a"],
    badge: "藏味",
    chew: "3级",
    fit: "3-12kg",
    clean: "冲洗",
    principles: ["藏味", "短骨", "耐咬"],
    playTitle: "藏味咀嚼短片",
    playCopy: "味道让咀嚼更专注。",
    playSteps: ["涂抹内槽。", "短时咀嚼。", "冲洗晾干。"],
    tags: ["chew", "puzzle", "five12", "washable"]
  },
  {
    id: "twist",
    name: "Twist Rope Bean",
    price: 15,
    description: "豆形绳结，抓咬轻松。",
    toy: "toy-knot",
    colors: ["#2b775f", "#ffe16a"],
    badge: "绳结",
    chew: "2级",
    fit: "1-10kg",
    clean: "手洗",
    principles: ["豆形", "绳结", "轻咬"],
    playTitle: "豆形绳结短片",
    playCopy: "小嘴找到抓点。",
    playSteps: ["递到侧口。", "轻扯轻放。", "慢慢啃咬。"],
    tags: ["chew", "quiet", "under5", "five12"]
  },
  {
    id: "orbit",
    name: "Orbit Snack Ring",
    price: 25,
    description: "环形藏食，滚动有戏。",
    toy: "toy-loop",
    colors: ["#8875e6", "#4eb5d8"],
    badge: "藏食",
    chew: "1级",
    fit: "1-12kg",
    clean: "水洗",
    principles: ["环形", "滚动", "藏食"],
    playTitle: "环形藏食短片",
    playCopy: "滚动把零食变远。",
    playSteps: ["填入小粒。", "轻滚启动。", "鼻工收尾。"],
    tags: ["puzzle", "starter", "washable", "under5", "five12"]
  },
  {
    id: "hush",
    name: "Hush Felt Bone",
    price: 16,
    description: "毛毡短骨，声音很轻。",
    toy: "toy-bone",
    colors: ["#fbf7ed", "#222b2f"],
    badge: "静音",
    chew: "1级",
    fit: "1-8kg",
    clean: "手洗",
    principles: ["毛毡", "低噪", "轻咬"],
    playTitle: "静音短骨短片",
    playCopy: "夜晚保留柔软声音。",
    playSteps: ["轻咬开场。", "抱玩停顿。", "收回篮中。"],
    tags: ["quiet", "gift", "under5"]
  }
];

const filterScopes = {
  play: ["chew", "puzzle", "fetch", "quiet"],
  weight: ["under5", "five12"],
  intent: ["starter", "gift", "washable"]
};

// 派生字段
products.forEach((product) => {
  product.play = product.tags.find((tag) => filterScopes.play.includes(tag)) || "quiet";
  product.weights = product.tags.filter((tag) => filterScopes.weight.includes(tag));
  product.intents = product.tags.filter((tag) => filterScopes.intent.includes(tag));
  product.cleaning = product.tags.includes("washable") ? "washable" : product.clean === "手洗" ? "handwash" : "rinse";
});

// 通用状态与工具
const state = {
  cart: [],
  filters: new Set(["all"])
};

const gridTransitionTimers = new WeakMap();

const qs = (selector, scope = document) => scope.querySelector(selector);
const qsa = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
const findProduct = (id) => products.find((product) => product.id === id);
const getProduct = (id) => findProduct(id) || products[0];

// 初始化入口
document.addEventListener("DOMContentLoaded", () => {
  initReveal();
  initNavigation();
  initRouteTransitions();
  initCart();
  initProductGrids();
  initFilters();
  initHomeFinder();
  initHeroStage();
  initPromiseLab();
  initShopDetail();
  initPlaybookLibrary();
  initTilt();
});

function initReveal() {
  const targets = qsa(".reveal");
  if (!targets.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14 });

  targets.forEach((target) => observer.observe(target));
}

function initNavigation() {
  const toggle = qs("[data-nav-toggle]");
  const nav = qs("[data-nav]");
  if (!toggle || !nav) return;

  const glider = document.createElement("span");
  glider.className = "nav-glider";
  glider.setAttribute("aria-hidden", "true");
  nav.prepend(glider);
  moveNavGlider(qs("[aria-current='page']", nav) || qs("a", nav));
  window.requestAnimationFrame(() => nav.classList.add("is-glider-ready"));
  window.addEventListener("resize", () => {
    moveNavGlider(qs(".is-transition-target", nav) || qs("[aria-current='page']", nav) || qs("a", nav));
  });

  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
    window.setTimeout(() => moveNavGlider(qs("[aria-current='page']", nav) || qs("a", nav)), 170);
  });
}

function moveNavGlider(link) {
  const nav = qs("[data-nav]");
  if (!nav || !link) return;
  const glider = qs(".nav-glider", nav);
  if (!glider) return;

  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const visualWidth = Math.max(38, linkRect.width - 14);
  const x = linkRect.left - navRect.left + (linkRect.width - visualWidth) / 2;
  const y = linkRect.top - navRect.top;
  nav.style.setProperty("--nav-glider-x", `${x}px`);
  nav.style.setProperty("--nav-glider-y", `${y}px`);
  nav.style.setProperty("--nav-glider-width", `${visualWidth}px`);
  nav.style.setProperty("--nav-glider-height", `${linkRect.height}px`);
}

function initRouteTransitions() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const overlay = document.createElement("div");
  overlay.className = "route-transition";
  overlay.setAttribute("aria-hidden", "true");
  document.body.append(overlay);

  if (sessionStorage.getItem("pupkit-route-transition") === "1" && !reducedMotion.matches) {
    sessionStorage.removeItem("pupkit-route-transition");
    overlay.classList.add("is-active");
    window.requestAnimationFrame(() => overlay.classList.remove("is-active"));
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || reducedMotion.matches) return;
    const link = event.target.closest("a[href]");
    if (!link || !isInternalPageLink(link)) return;

    const targetUrl = new URL(link.getAttribute("href"), window.location.href);
    event.preventDefault();
    qsa(".site-nav a").forEach((item) => item.classList.remove("is-transition-target"));
    const targetNavLink = getNavLinkForUrl(targetUrl);
    if (targetNavLink) {
      targetNavLink.classList.add("is-transition-target");
      moveNavGlider(targetNavLink);
    }
    overlay.classList.add("is-active");
    document.body.classList.add("is-route-leaving");
    sessionStorage.setItem("pupkit-route-transition", "1");
    window.setTimeout(() => {
      window.location.href = targetUrl.href;
    }, 300);
  });
}

function isInternalPageLink(link) {
  if (link.target || link.hasAttribute("download") || link.getAttribute("aria-disabled") === "true") return false;
  const href = link.getAttribute("href");
  if (!href || href.startsWith("#")) return false;

  const targetUrl = new URL(href, window.location.href);
  if (targetUrl.origin !== window.location.origin) return false;
  const file = targetUrl.pathname.split("/").pop() || "index.html";
  if (!["index.html", "shop.html", "playbook.html"].includes(file)) return false;
  if (targetUrl.pathname === window.location.pathname && targetUrl.search === window.location.search) return false;
  return true;
}

function getNavLinkForUrl(url) {
  const file = url.pathname.split("/").pop() || "index.html";
  return qsa(".site-nav a").find((link) => {
    const linkUrl = new URL(link.getAttribute("href"), window.location.href);
    const linkFile = linkUrl.pathname.split("/").pop() || "index.html";
    return linkFile === file;
  });
}

// 购物袋
function initCart() {
  const overlay = document.createElement("div");
  overlay.className = "cart-overlay";
  overlay.setAttribute("data-cart-overlay", "");

  const drawer = document.createElement("aside");
  drawer.className = "cart-drawer";
  drawer.setAttribute("aria-label", "购物袋");
  drawer.innerHTML = `
    <div class="cart-head">
      <h2>玩具袋</h2>
      <button class="icon-button" type="button" data-cart-close aria-label="关闭购物袋">×</button>
    </div>
    <div class="cart-items" data-cart-items></div>
    <div class="cart-total"><span>小计</span><strong data-cart-total>$0</strong></div>
    <button class="button primary" type="button" data-checkout-disabled>前去支付</button>
  `;
  document.body.append(overlay, drawer);

  document.addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-cart-open]");
    const closeButton = event.target.closest("[data-cart-close]");
    const addButton = event.target.closest("[data-add-cart]");
    const decreaseButton = event.target.closest("[data-cart-decrease]");
    const removeButton = event.target.closest("[data-cart-remove]");
    const checkoutButton = event.target.closest("[data-checkout-disabled]");

    if (openButton) openCart();
    if (closeButton || event.target === overlay) closeCart();
    if (addButton) {
      addToCart(addButton.dataset.addCart);
      flyToCart(getProductVisual(addButton));
      showToast("进入玩具袋");
    }
    if (decreaseButton) decreaseCartItem(decreaseButton.dataset.cartDecrease);
    if (removeButton) removeCartItem(removeButton.dataset.cartRemove);
    if (checkoutButton) showToast("支付功能未接入");
  });

  renderCart();
}

function openCart() {
  qs("[data-cart-overlay]")?.classList.add("is-open");
  qs(".cart-drawer")?.classList.add("is-open");
  document.body.classList.add("is-locked");
}

function closeCart() {
  qs("[data-cart-overlay]")?.classList.remove("is-open");
  qs(".cart-drawer")?.classList.remove("is-open");
  document.body.classList.remove("is-locked");
}

function addToCart(id) {
  if (id === "starter") {
    ["loop", "calm"].forEach((item) => state.cart.push(item));
  } else {
    state.cart.push(id);
  }
  renderCart();
}

function decreaseCartItem(id) {
  const index = state.cart.indexOf(id);
  if (index === -1) return;

  state.cart.splice(index, 1);
  renderCart();
}

function removeCartItem(id) {
  state.cart = state.cart.filter((item) => item !== id);
  renderCart();
}

function renderCart() {
  const counts = qsa("[data-cart-count]");
  counts.forEach((count) => {
    count.textContent = state.cart.length;
  });

  const items = qs("[data-cart-items]");
  const total = qs("[data-cart-total]");
  if (!items || !total) return;

  if (!state.cart.length) {
    items.innerHTML = `<p class="empty-cart">灵感玩具暂存处。</p>`;
    total.textContent = "$0";
    return;
  }

  const grouped = state.cart.reduce((acc, id) => {
    acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});

  let sum = 0;
  items.innerHTML = Object.entries(grouped).map(([id, qty]) => {
    const product = getProduct(id);
    sum += product.price * qty;
    return `
      <div class="cart-item">
        <div class="cart-line-copy">
          <strong>${product.name}</strong>
          <span>数量 ${qty}</span>
        </div>
        <div class="cart-line-actions">
          <strong>$${product.price * qty}</strong>
          <button class="cart-small-action" type="button" data-cart-decrease="${product.id}" aria-label="减少 ${product.name} 数量">-</button>
          <button class="cart-small-action remove" type="button" data-cart-remove="${product.id}" aria-label="移除 ${product.name}">移除</button>
        </div>
      </div>
    `;
  }).join("");
  total.textContent = `$${sum}`;
}

function showToast(message) {
  let toast = qs(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 1700);
}

function getProductVisual(trigger) {
  const detailPanel = trigger.closest("[data-shop-detail-panel]");
  if (detailPanel) return qs("[data-shop-detail-visual]", detailPanel) || trigger;
  const card = trigger.closest("[data-product-card]");
  return card ? qs(".toy-render", card) || trigger : trigger;
}

function flyToCart(source) {
  const bag = qs("[data-cart-open]");
  if (!source || !bag) return;
  const sourceRect = source.getBoundingClientRect();
  const bagRect = bag.getBoundingClientRect();
  const flyer = source.cloneNode(true);
  flyer.classList.add("cart-flyer");
  flyer.setAttribute("aria-hidden", "true");
  flyer.style.left = `${sourceRect.left + sourceRect.width / 2}px`;
  flyer.style.top = `${sourceRect.top + sourceRect.height / 2}px`;
  flyer.style.width = `${sourceRect.width}px`;
  flyer.style.height = `${sourceRect.height}px`;
  const flyX = bagRect.left + bagRect.width / 2 - sourceRect.left - sourceRect.width / 2;
  const flyY = bagRect.top + bagRect.height / 2 - sourceRect.top - sourceRect.height / 2;
  const focusX = window.innerWidth / 2 - sourceRect.left - sourceRect.width / 2;
  const focusY = window.innerHeight / 2 - sourceRect.top - sourceRect.height / 2;
  const focusScale = Math.min(1.65, Math.max(1.08, 190 / Math.max(sourceRect.width, sourceRect.height, 1)));
  const veil = showCartFocusVeil();
  flyer.style.setProperty("--fly-x", `${flyX}px`);
  flyer.style.setProperty("--fly-y", `${flyY}px`);
  flyer.style.setProperty("--focus-x", `${focusX}px`);
  flyer.style.setProperty("--focus-y", `${focusY}px`);
  flyer.style.setProperty("--focus-scale", `${focusScale}`);
  document.body.append(flyer);
  bag.classList.add("is-catching");
  window.setTimeout(() => releaseCartFocusVeil(veil), 780);
  window.setTimeout(() => flyer.remove(), 1180);
  window.setTimeout(() => bag.classList.remove("is-catching"), 1120);
}

function showCartFocusVeil() {
  qsa(".cart-focus-veil").forEach((node) => node.remove());
  const veil = document.createElement("div");
  veil.className = "cart-focus-veil";
  veil.setAttribute("aria-hidden", "true");
  veil.style.setProperty("--veil-x", `${window.innerWidth / 2}px`);
  veil.style.setProperty("--veil-y", `${window.innerHeight / 2}px`);
  document.body.append(veil);
  window.requestAnimationFrame(() => veil.classList.add("is-active"));
  return veil;
}

function releaseCartFocusVeil(veil) {
  if (!veil || !veil.isConnected) return;
  veil.classList.add("is-leaving");
  veil.classList.remove("is-active");
  window.setTimeout(() => veil.remove(), 460);
}

// 商品渲染与筛选
function initProductGrids() {
  qsa("[data-product-grid]").forEach((grid) => {
    renderProductGrid(grid, products);
  });

  const params = new URLSearchParams(window.location.search);
  const initialFilters = new Set();
  const play = params.get("play");
  const weight = params.get("weight");
  const filter = params.get("filter");

  if (filterScopes.play.includes(play)) initialFilters.add(play);
  if (filterScopes.weight.includes(weight)) initialFilters.add(weight);
  if (!initialFilters.size && filter && filterScopes.play.includes(filter)) {
    initialFilters.add(filter);
  }

  if (initialFilters.size) {
    state.filters = initialFilters;
    syncFilterButtons();
  }

  updateProductVisibility();
  initCardPointer();
}

function renderProductGrid(grid, source) {
  const limit = Number(grid.dataset.limit) || source.length;
  grid.innerHTML = source.slice(0, limit).map((product, index) => productCard(product, index)).join("");
}

function animateGridChange(grid, applyChange, switchDelay = 170, settleDelay = 560) {
  window.clearTimeout(gridTransitionTimers.get(grid));
  const transitionId = `${Date.now()}-${Math.random()}`;
  grid.dataset.gridTransition = transitionId;
  grid.classList.remove("is-filtering-in");
  grid.classList.add("is-filtering-out");
  const timer = window.setTimeout(() => {
    if (grid.dataset.gridTransition !== transitionId) return;
    applyChange();
    grid.classList.remove("is-filtering-out");
    grid.classList.add("is-filtering-in");
    window.setTimeout(() => {
      if (grid.dataset.gridTransition !== transitionId) return;
      grid.classList.remove("is-filtering-in");
      delete grid.dataset.gridTransition;
    }, settleDelay);
  }, switchDelay);
  gridTransitionTimers.set(grid, timer);
}

function productCard(product, index = 0) {
  const [a, b] = product.colors;
  return `
    <article
      class="product-card"
      style="--card-index:${index}"
      data-product-card
      data-product-id="${product.id}"
      data-play="${product.play}"
      data-weights="${product.weights.join(" ")}"
      data-intents="${product.intents.join(" ")}"
      data-cleaning="${product.cleaning}"
    >
      <div class="product-card-media">
        <div class="product-badges">
          <span>${product.badge}</span>
          <span>${product.chew}</span>
        </div>
        <div class="toy-render ${product.toy}" style="--toy-a:${a};--toy-b:${b}" aria-hidden="true"></div>
      </div>
      <h3>${product.name}</h3>
      <p>${product.description}</p>
      <div class="product-meta">
        <span>尺度 <strong>${product.fit}</strong></span>
        <span>清洁 <strong>${product.clean}</strong></span>
        <span>玩法 <strong>${product.badge}</strong></span>
      </div>
      <div class="product-card-footer">
        <strong class="product-price">$${product.price}</strong>
        <button class="mini-link" type="button" data-detail="${product.id}">详情</button>
        <button class="add-mini" type="button" data-add-cart="${product.id}">加入</button>
      </div>
    </article>
  `;
}

function initFilters() {
  const filterButtons = qsa("[data-filter]");
  if (!filterButtons.length) return;

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      const scope = button.dataset.filterScope;
      if (filter === "all") {
        state.filters = new Set(["all"]);
      } else {
        state.filters.delete("all");
        if (scope === "play") {
          filterButtons.forEach((item) => {
            if (item.dataset.filterScope === "play") state.filters.delete(item.dataset.filter);
          });
        }
        if (state.filters.has(filter)) {
          state.filters.delete(filter);
        } else {
          state.filters.add(filter);
        }
        if (!state.filters.size) state.filters.add("all");
      }
      syncFilterButtons();
      updateProductVisibility({ animate: true });
    });
  });

  qs("[data-filter-reset]")?.addEventListener("click", () => {
    state.filters = new Set(["all"]);
    syncFilterButtons();
    updateProductVisibility({ animate: true });
  });

  qsa("[data-density]").forEach((button) => {
    button.addEventListener("click", () => {
      qsa("[data-density]").forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      qs(".shop-results")?.classList.toggle("is-dense", button.dataset.density === "dense");
    });
  });
}

function syncFilterButtons() {
  qsa("[data-filter]").forEach((button) => {
    button.classList.toggle("is-active", state.filters.has(button.dataset.filter));
  });
}

function updateProductVisibility({ animate = false } = {}) {
  const grid = qs("[data-page='shop'] [data-product-grid]");
  const applyVisibility = () => {
    const cards = qsa("[data-product-card]");
    let visible = 0;
    const active = getActiveFilterGroups();

    cards.forEach((card) => {
      const product = findProduct(card.dataset.productId);
      const show = product ? productMatchesFilters(product, active) : false;
      card.hidden = !show;
      if (show) {
        card.style.setProperty("--card-index", `${visible}`);
        visible += 1;
      }
    });

    qsa("[data-product-count]").forEach((node) => {
      node.textContent = visible || products.length;
    });
  };

  if (!animate || !grid) {
    applyVisibility();
    return;
  }

  animateGridChange(grid, () => {
    applyVisibility();
  });
}

function getActiveFilterGroups() {
  const groups = {};
  qsa("[data-filter].is-active").forEach((button) => {
    const scope = button.dataset.filterScope;
    const filter = button.dataset.filter;
    if (!scope || filter === "all") return;
    groups[scope] ||= [];
    groups[scope].push(filter);
  });
  return groups;
}

function productMatchesFilters(product, groups) {
  if (groups.play?.length && !groups.play.includes(product.play)) return false;
  if (groups.weight?.length && !groups.weight.some((filter) => product.weights.includes(filter))) return false;
  if (groups.intent?.length && !groups.intent.some((filter) => product.intents.includes(filter))) return false;
  return true;
}

// 首页入口
function initHomeFinder() {
  const finder = qs("[data-home-finder]");
  if (!finder) return;

  const preview = qs("[data-benefit-preview]");
  const playOptions = qsa("[data-home-play]", finder);
  const weightOptions = qsa("[data-home-weight]", finder);
  const entry = qs("[data-home-shop-entry]", finder);
  if (!preview || !playOptions.length || !weightOptions.length || !entry) return;

  const title = qs("strong", preview);
  const copy = qs("p", preview);
  const selection = { play: "", weight: "" };

  const updateEntry = () => {
    const playButton = playOptions.find((button) => button.dataset.homePlay === selection.play);
    const weightButton = weightOptions.find((button) => button.dataset.homeWeight === selection.weight);
    const ready = Boolean(playButton && weightButton);

    if (ready) {
      const params = new URLSearchParams({ play: selection.play, weight: selection.weight });
      entry.href = `shop.html?${params.toString()}`;
      entry.classList.remove("is-disabled");
      entry.setAttribute("aria-disabled", "false");
      if (title) title.textContent = `${playButton.dataset.benefitTitle} / ${weightButton.dataset.weightTitle}`;
      if (copy) copy.textContent = weightButton.dataset.weightCopy;
      return;
    }

    entry.href = "shop.html";
    entry.classList.add("is-disabled");
    entry.setAttribute("aria-disabled", "true");
    if (title) title.textContent = "等待两项";
    if (copy) copy.textContent = selection.play ? "再选小狗尺度，货架才会收窄。" : "玩法和尺度对上，货架才有意义。";
  };

  playOptions.forEach((button) => {
    button.addEventListener("click", () => {
      selection.play = button.dataset.homePlay;
      playOptions.forEach((item) => item.classList.toggle("is-featured", item === button));
      updateEntry();
    });
  });

  weightOptions.forEach((button) => {
    button.addEventListener("click", () => {
      selection.weight = button.dataset.homeWeight;
      weightOptions.forEach((item) => item.classList.toggle("is-active", item === button));
      updateEntry();
    });
  });

  entry.addEventListener("click", (event) => {
    if (entry.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
      showToast("先选玩法和尺度");
    }
  });

  updateEntry();
}

function initHeroStage() {
  const stage = qs("[data-hero-stage]");
  if (!stage) return;

  let frame = 0;
  document.addEventListener("pointermove", (event) => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const x = event.clientX / window.innerWidth;
      const y = event.clientY / window.innerHeight;
      const sx = (x - 0.5) * 2;
      const sy = (y - 0.5) * 2;
      stage.style.setProperty("--stage-x", `${sx}`);
      stage.style.setProperty("--stage-y", `${sy}`);
      stage.style.setProperty("--ring-one-x", `${sx * 5}px`);
      stage.style.setProperty("--ring-one-y", `${sy * 4}px`);
      stage.style.setProperty("--ring-two-x", `${sx * -6}px`);
      stage.style.setProperty("--ring-two-y", `${sy * -5}px`);
      stage.style.setProperty("--hero-main-x", `${sx * -6}px`);
      stage.style.setProperty("--hero-main-y", `${sy * -5}px`);
      stage.style.setProperty("--hero-side-x", `${sx * 7}px`);
      stage.style.setProperty("--hero-side-y", `${sy * 6}px`);
      stage.style.setProperty("--hero-third-x", `${sx * 5}px`);
      stage.style.setProperty("--hero-third-y", `${sy * -6}px`);
      stage.style.setProperty("--trail-x", `${sx * 14}px`);
      stage.style.setProperty("--trail-y", `${sy * -5}px`);
      stage.style.setProperty("--cursor-x", `${x * 100}%`);
      stage.style.setProperty("--cursor-y", `${y * 100}%`);
    });
  });
}

function initPromiseLab() {
  const lab = qs("[data-promise-lab]");
  if (!lab) return;

  const cards = qsa("[data-promise-card]", lab);
  const label = qs("[data-promise-label]", lab);
  const statement = qs("[data-promise-statement]", lab);
  let pointerFrame = 0;

  const activate = (card) => {
    cards.forEach((item) => item.classList.toggle("is-active", item === card));
    lab.dataset.promiseTone = card.dataset.promiseTone || "heart";
    lab.style.setProperty("--promise-accent", card.dataset.promiseColor || "#f2553c");
    if (label) label.textContent = card.dataset.promiseLabel || "";
    if (statement) statement.textContent = card.dataset.promiseStatement || "";
  };

  cards.forEach((card) => {
    card.addEventListener("pointerenter", () => activate(card));
    card.addEventListener("focus", () => activate(card));
    card.addEventListener("click", () => activate(card));
  });

  if (cards[0]) activate(cards[0]);

  lab.addEventListener("pointermove", (event) => {
    window.cancelAnimationFrame(pointerFrame);
    pointerFrame = window.requestAnimationFrame(() => {
      const rect = lab.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const sx = Math.max(-1, Math.min(1, (x - 0.5) * 2));
      const sy = Math.max(-1, Math.min(1, (y - 0.5) * 2));
      lab.style.setProperty("--promise-cursor-x", `${x * 100}%`);
      lab.style.setProperty("--promise-cursor-y", `${y * 100}%`);
      lab.style.setProperty("--promise-copy-x", `${sx * -5}px`);
      lab.style.setProperty("--promise-copy-y", `${sy * -3}px`);
      lab.style.setProperty("--promise-core-x", `${sx * 7}px`);
      lab.style.setProperty("--promise-core-y", `${sy * 6}px`);
      lab.style.setProperty("--promise-card-x", `${sx * -3}px`);
      lab.style.setProperty("--promise-card-y", `${sy * 3}px`);
      lab.style.setProperty("--promise-tilt-x", `${sy * -2}deg`);
      lab.style.setProperty("--promise-tilt-y", `${sx * 3}deg`);
    });
  });

  lab.addEventListener("pointerleave", () => {
    lab.style.setProperty("--promise-cursor-x", "50%");
    lab.style.setProperty("--promise-cursor-y", "50%");
    lab.style.setProperty("--promise-copy-x", "0px");
    lab.style.setProperty("--promise-copy-y", "0px");
    lab.style.setProperty("--promise-core-x", "0px");
    lab.style.setProperty("--promise-core-y", "0px");
    lab.style.setProperty("--promise-card-x", "0px");
    lab.style.setProperty("--promise-card-y", "0px");
    lab.style.setProperty("--promise-tilt-x", "0deg");
    lab.style.setProperty("--promise-tilt-y", "0deg");
  });
}

// 商店详情抽屉
function initShopDetail() {
  const panel = qs("[data-shop-detail-panel]");
  const overlay = qs("[data-detail-overlay]");

  const params = new URLSearchParams(window.location.search);
  const detailId = params.get("detail");
  if (panel) updateShopDetail(detailId || products[0].id, Boolean(detailId), Boolean(detailId));

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-detail]");
    if (!button) return;
    event.preventDefault();
    updateShopDetail(button.dataset.detail, true, true);
  });

  if (panel) {
    document.addEventListener("click", (event) => {
      const card = event.target.closest("[data-product-card]");
      if (!card || event.target.closest("[data-add-cart]") || event.target.closest("[data-detail]")) return;
      updateShopDetail(card.dataset.productId, true, true);
    });
  }

  document.addEventListener("pointerover", (event) => {
    const button = event.target.closest?.("[data-detail]");
    if (!button) return;
    button.closest("[data-product-card]")?.classList.add("is-previewed");
  });

  document.addEventListener("pointerout", (event) => {
    const button = event.target.closest?.("[data-detail]");
    if (!button) return;
    button.closest("[data-product-card]")?.classList.remove("is-previewed");
  });

  qs("[data-detail-close]")?.addEventListener("click", closeDetailDrawer);
  overlay?.addEventListener("click", closeDetailDrawer);
}

function updateShopDetail(id, open = false, markSelection = true) {
  const panel = qs("[data-shop-detail-panel]");
  if (!panel) {
    window.location.href = `shop.html?detail=${encodeURIComponent(id)}`;
    return;
  }

  const product = getProduct(id);
  const [a, b] = product.colors;
  qs("[data-shop-detail-badge]", panel).textContent = `${product.badge} / ${product.chew}`;
  qs("[data-shop-detail-name]", panel).textContent = product.name;
  qs("[data-shop-detail-description]", panel).textContent = product.description;
  qs("[data-shop-detail-fit]", panel).textContent = product.fit;
  qs("[data-shop-detail-clean]", panel).textContent = product.clean;
  qs("[data-shop-detail-price]", panel).textContent = `$${product.price}`;
  const visual = qs("[data-shop-detail-visual]", panel);
  if (visual) {
    visual.className = `toy-render ${product.toy} hero-toy`;
    visual.style.setProperty("--toy-a", a);
    visual.style.setProperty("--toy-b", b);
  }
  qs("[data-shop-detail-principles]", panel).innerHTML = product.principles
    .map((item) => `<span>${item}</span>`)
    .join("");
  qs("[data-shop-detail-cart]", panel).dataset.addCart = product.id;
  qsa("[data-detail]").forEach((button) => {
    button.classList.toggle("is-active", markSelection && button.dataset.detail === product.id);
  });
  qsa("[data-product-card]").forEach((card) => {
    card.classList.toggle("is-selected", markSelection && card.dataset.productId === product.id);
  });
  if (open) openDetailDrawer();
}

function openDetailDrawer() {
  qs("[data-detail-overlay]")?.classList.add("is-open");
  const panel = qs("[data-shop-detail-panel]");
  panel?.classList.add("is-open");
  panel?.setAttribute("aria-hidden", "false");
  document.body.classList.add("is-locked");
}

function closeDetailDrawer() {
  qs("[data-detail-overlay]")?.classList.remove("is-open");
  const panel = qs("[data-shop-detail-panel]");
  panel?.classList.remove("is-open");
  panel?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("is-locked");
}

// 玩法指南
function initPlaybookLibrary() {
  const list = qs("[data-play-list]");
  if (!list) return;

  list.innerHTML = products.map((product, index) => `
    <button type="button" class="${index === 0 ? "is-active" : ""}" data-play-product="${product.id}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${product.name}</strong>
      <small>${product.badge} / ${product.description}</small>
    </button>
  `).join("");

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-play-product]");
    if (!button) return;
    qsa("[data-play-product]", list).forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    updatePlaybook(button.dataset.playProduct);
  });

  updatePlaybook(products[0].id);
}

function updatePlaybook(id) {
  const product = getProduct(id);
  qs("[data-play-video-label]").textContent = `${product.name} / 玩法影像`;
  qs("[data-play-badge]").textContent = `${product.badge} / ${product.chew}`;
  qs("[data-play-title]").textContent = product.playTitle;
  qs("[data-play-copy]").textContent = product.playCopy;
  qs("[data-play-steps]").innerHTML = product.playSteps
    .map((item) => `<li>${item}</li>`)
    .join("");
}

// 轻量指针动效
function initTilt() {
  qsa("[data-tilt-stage]:not([data-hero-stage])").forEach((stage) => {
    stage.addEventListener("pointermove", (event) => {
      const rect = stage.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      stage.style.transform = `rotateX(${y * -3}deg) rotateY(${x * 4}deg)`;
    });
    stage.addEventListener("pointerleave", () => {
      stage.style.transform = "";
    });
  });
}

function initCardPointer() {
  qsa("[data-product-card]").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
      card.style.setProperty("--ry", `${(x - 0.5) * 5}deg`);
      card.style.setProperty("--rx", `${(0.5 - y) * 4}deg`);
    });

    card.addEventListener("pointerleave", () => {
      card.style.removeProperty("--ry");
      card.style.removeProperty("--rx");
    });
  });
}
