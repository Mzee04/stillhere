const STORAGE_KEY = "stillhere-checkout-v1";
const stageTitles = {
  catalog: "A good mug, on its way",
  cart: "Your cart",
  contact: "Where should we send it?",
  delivery: "Choose delivery",
  review: "Review order",
};
const stepOrder = ["cart", "contact", "delivery", "review"];

function freshState() {
  return {
    stage: "catalog",
    page: "checkout",
    cart: [],
    customer: { name: "", email: "" },
    delivery: "standard",
    hasReturned: false,
    hasRefreshed: false,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || !Array.isArray(saved.cart) || !saved.customer) return freshState();
    return {
      ...freshState(),
      ...saved,
      cart: saved.cart,
      customer: { name: String(saved.customer.name || ""), email: String(saved.customer.email || "") },
    };
  } catch {
    return freshState();
  }
}

function persistState() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage can be unavailable in restricted browsers */ }
}

let state = loadState();
const validStages = new Set(Object.keys(stageTitles));
const initialHistoryState = history.state;
if (initialHistoryState?.page === "checkout" && validStages.has(initialHistoryState.stage)) {
  state.page = "checkout";
  state.stage = initialHistoryState.stage;
} else if (initialHistoryState?.page === "detail" && validStages.has(initialHistoryState.stage)) {
  state.page = "detail";
  state.stage = initialHistoryState.stage;
}
if (!initialHistoryState) {
  const urlStage = new URLSearchParams(location.search).get("stage");
  if (validStages.has(urlStage)) state.stage = urlStage;
  history.replaceState({ page: state.page, stage: state.stage }, "", location.href);
}
const app = document.querySelector("#app");
const resetButton = document.querySelector("#reset-demo");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function itemCount() {
  return state.cart.reduce((count, item) => count + item.quantity, 0);
}

function total() {
  return state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function setStage(stage, { replace = false } = {}) {
  state.stage = stage;
  state.page = "checkout";
  state.hasReturned = false;
  const url = `/shop?stage=${encodeURIComponent(stage)}`;
  if (replace) history.replaceState({ page: "checkout", stage }, "", url);
  else history.pushState({ page: "checkout", stage }, "", url);
  persistState();
  render();
}

function art(detail = false) {
  return `<div class="product-art ${detail ? "detail-art" : ""}" role="img" aria-label="Cream insulated travel mug"><div class="mug"></div></div>`;
}

function productCard() {
  const inCart = itemCount() > 0;
  const action = state.stage === "catalog"
    ? `<button class="primary-action" data-action="add">Add to cart <span class="arrow">＋</span></button>`
    : `<button class="primary-action" data-action="continue-cart">Continue to checkout <span class="arrow">→</span></button>`;
  return `<div class="product-card">
    ${art()}
    <div class="product-details">
      <span class="product-tag">Sonder Supply · Everyday series</span>
      <h3 class="product-name">Sonder travel mug</h3>
      <p class="product-description">Keeps the good part of your morning warm. Built for the commute and the long way home.</p>
      <div class="product-meta"><span class="price">$34.00</span><button class="product-link" data-action="details">Product details</button></div>
    </div>
  </div>
  <div class="empty-cart ${inCart ? "has-item" : ""}" id="cart-summary"><span>${inCart ? "In your cart · Sonder travel mug" : "Your cart is waiting"}</span><b>${inCart ? `Qty ${itemCount()} · ${money(total())}` : "Add one item to begin"}</b></div>
  <div class="checkout-actions">${state.stage === "cart" ? `<button class="text-action" data-action="keep-shopping">← Keep shopping</button>` : `<span></span>`}${action}</div>`;
}

function contactForm() {
  return `<div class="form-grid">
    <div class="field full"><label for="customer-name">Full name</label><input id="customer-name" name="name" autocomplete="name" placeholder="Amina Bello" value="${escapeHtml(state.customer.name)}" /></div>
    <div class="field full"><label for="customer-email">Email address</label><input id="customer-email" name="email" autocomplete="email" type="email" placeholder="amina@example.com" value="${escapeHtml(state.customer.email)}" /></div>
  </div>
  <p class="step-hint">Your details stay with this sample checkout.</p>
  <div class="checkout-actions"><button class="text-action" data-action="back-contact">← Back to cart</button><button class="primary-action" data-action="continue-contact">Continue to delivery <span class="arrow">→</span></button></div>`;
}

function deliveryForm() {
  return `<label class="delivery-option"><input type="radio" name="delivery" value="standard" ${state.delivery === "standard" ? "checked" : ""} /><span class="delivery-option-copy">Standard delivery<small>Arrives in 3–5 business days</small></span><span class="delivery-price">FREE</span></label>
  <p class="step-hint">Your order will ship to the address on your profile. No address is collected in this demo.</p>
  <div class="checkout-actions"><button class="text-action" data-action="back-delivery">← Back to details</button><button class="primary-action" data-action="continue-delivery">Review order <span class="arrow">→</span></button></div>`;
}

function reviewOrder() {
  const item = state.cart[0];
  return `<div class="review-box">
    <div class="review-section"><span class="review-label">Contact</span><span class="review-value"><b>${escapeHtml(state.customer.name || "Name missing")}</b>${escapeHtml(state.customer.email || "Email missing")}</span></div>
    <div class="review-section"><span class="review-label">In your cart</span><span class="review-value"><b>${escapeHtml(item?.name || "Cart is empty")}</b>Quantity ${item?.quantity ?? 0}</span></div>
    <div class="review-section"><span class="review-label">Delivery</span><span class="review-value"><b>Standard delivery</b>3–5 business days</span></div>
    <div class="review-total"><span>Total</span><strong>${money(total())}</strong></div>
  </div>
  <div class="checkout-actions"><button class="text-action" data-action="back-review">← Edit details</button><div class="action-stack"><button class="text-action details-action" data-action="details">Product details</button><button class="text-action refresh-action" data-action="refresh">↻ Refresh</button></div></div>
  <p class="step-hint">This is a test order. No payment will be taken.</p>`;
}

function detailPage() {
  return `${art(true)}<p class="shop-kicker">Sonder Supply · Everyday series</p><h2 class="shop-title">Sonder travel mug</h2><p class="detail-copy">A quiet, durable companion for coffee before the train, tea after the trail, and every little pause between. Double-wall steel, ceramic-lined, 12 oz.</p>
  <div class="checkout-actions"><button class="primary-action" data-action="back-to-checkout">← Back to checkout</button><span class="price">$34.00</span></div>
  <p class="step-hint">Use this page to leave checkout, then come back. Your cart and current step should still be waiting.</p>`;
}

function progressMarkup() {
  const activeIndex = Math.max(0, stepOrder.indexOf(state.stage));
  return `<div class="stepper" aria-label="Checkout progress">${stepOrder.map((step, index) => `<div class="step-node ${index < activeIndex ? "complete" : ""} ${index === activeIndex ? "active" : ""}"><span class="step-count">${index < activeIndex ? "✓" : index + 1}</span><span>${step[0].toUpperCase()}${step.slice(1)}</span></div>${index < stepOrder.length - 1 ? "<span class=\"step-connector\"></span>" : ""}`).join("")}</div>`;
}

function updatePanels() {
  const cart = document.querySelector("#state-cart");
  const step = document.querySelector("#state-step");
  const customer = document.querySelector("#state-customer");
  if (cart) cart.textContent = itemCount() ? `${itemCount()} item · ${money(total())}` : "Empty";
  if (step) step.textContent = state.stage === "catalog" ? "Product" : stageTitles[state.stage] || "Product";
  if (customer) customer.textContent = state.customer.name || "—";
  const marks = {
    cart: itemCount() > 0,
    contact: Boolean(state.customer.name && state.customer.email),
    back: Boolean(state.hasReturned),
    refresh: Boolean(state.hasRefreshed),
  };
  for (const [key, complete] of Object.entries(marks)) {
    const mark = document.querySelector(`[data-state="${key}"]`);
    if (!mark) continue;
    mark.textContent = complete ? "✓" : "○";
    mark.classList.toggle("done", complete);
  }
}

function attachInteractions() {
  app.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "add") {
        state.cart = [{ id: "sonder-mug", name: "Sonder travel mug", price: 34, quantity: 1 }];
        persistState();
        setStage("cart");
      } else if (action === "continue-cart") setStage("contact");
      else if (action === "continue-contact") {
        if (!state.customer.name.trim() || !state.customer.email.trim()) {
          const error = app.querySelector(".shop-error");
          if (error) error.remove();
          app.querySelector(".shop-content")?.insertAdjacentHTML("beforeend", `<p class="shop-error" role="alert">Enter your name and email to continue.</p>`);
          return;
        }
        setStage("delivery");
      } else if (action === "continue-delivery") setStage("review");
      else if (action === "back-contact") setStage("cart");
      else if (action === "back-delivery") setStage("contact");
      else if (action === "back-review") setStage("delivery");
      else if (action === "details") {
        state.page = "detail";
        persistState();
        history.pushState({ page: "detail", stage: state.stage }, "", "/shop/product/sonder-mug");
        render();
      } else if (action === "back-to-checkout") history.back();
      else if (action === "refresh") {
        state.hasRefreshed = true;
        persistState();
        window.location.reload();
      } else if (action === "keep-shopping") setStage("catalog");
    });
  });

  const nameInput = app.querySelector("#customer-name");
  const emailInput = app.querySelector("#customer-email");
  nameInput?.addEventListener("input", (event) => { state.customer.name = event.target.value; persistState(); updatePanels(); });
  emailInput?.addEventListener("input", (event) => { state.customer.email = event.target.value; persistState(); updatePanels(); });
  app.querySelectorAll('input[name="delivery"]').forEach((input) => {
    input.addEventListener("change", (event) => { state.delivery = event.target.value; persistState(); });
  });
}

function render() {
  const onDetail = state.page === "detail";
  const title = onDetail ? "Product details" : (stageTitles[state.stage] || stageTitles.catalog);
  const content = onDetail
    ? detailPage()
    : state.stage === "catalog" || state.stage === "cart"
      ? productCard()
      : state.stage === "contact"
        ? contactForm()
        : state.stage === "delivery"
          ? deliveryForm()
          : reviewOrder();
  app.innerHTML = `<div class="shop-content">
    <div class="shop-heading"><div><p class="shop-kicker">Sonder Supply · Secure checkout</p><h2 class="shop-title">${title}</h2></div><span class="order-id">DEMO ORDER</span></div>
    ${onDetail ? "" : progressMarkup()}
    ${content}
  </div>`;
  attachInteractions();
  updatePanels();
}

resetButton.addEventListener("click", () => {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage can be unavailable in restricted browsers */ }
  state = freshState();
  history.replaceState({ page: "checkout", stage: "catalog" }, "", "/shop");
  render();
});

window.addEventListener("popstate", (event) => {
  const saved = loadState();
  state = saved;
  if (event.state?.page === "checkout" && validStages.has(event.state.stage)) {
    state.page = "checkout";
    state.stage = event.state.stage;
    state.hasReturned = true;
  } else if (event.state?.page === "detail" && validStages.has(event.state.stage)) {
    state.page = "detail";
    state.stage = event.state.stage;
  } else {
    state.page = "checkout";
  }
  persistState();
  render();
});

persistState();
render();
