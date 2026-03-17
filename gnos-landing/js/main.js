/* =============================================
   GNOS — Landing Page JavaScript
   ============================================= */

// ── Mobile Menu ──────────────────────────────
const hamburger = document.querySelector('.nav-hamburger');
const mobileMenu = document.querySelector('.mobile-menu');
const mobileClose = document.querySelector('.mobile-menu-close');

if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => {
    mobileMenu.classList.add('open');
    document.body.style.overflow = 'hidden';
  });
}

if (mobileClose && mobileMenu) {
  mobileClose.addEventListener('click', () => {
    mobileMenu.classList.remove('open');
    document.body.style.overflow = '';
  });
}

// ── Nav active state ─────────────────────────
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a, .mobile-menu a').forEach(link => {
  const href = link.getAttribute('href');
  if (href === currentPage || (currentPage === '' && href === 'index.html')) {
    link.classList.add('active');
  }
});

// ── Scroll-reveal animation ───────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('revealed');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll(
  '.feature-card, .quote-card, .principle-card, .timeline-item, .showcase-split, .pricing-card, .stat-item'
).forEach(el => {
  el.classList.add('reveal');
  revealObserver.observe(el);
});

// ── Inject reveal CSS ─────────────────────────
const revealStyle = document.createElement('style');
revealStyle.textContent = `
  .reveal {
    opacity: 0;
    transform: translateY(20px);
    transition: opacity .5s ease, transform .5s ease;
  }
  .reveal.revealed {
    opacity: 1;
    transform: translateY(0);
  }
  .feature-card:nth-child(2) { transition-delay: .07s; }
  .feature-card:nth-child(3) { transition-delay: .14s; }
  .feature-card:nth-child(4) { transition-delay: .07s; }
  .feature-card:nth-child(5) { transition-delay: .14s; }
  .feature-card:nth-child(6) { transition-delay: .21s; }
  .quote-card:nth-child(2) { transition-delay: .07s; }
  .quote-card:nth-child(3) { transition-delay: .14s; }
  .stat-item:nth-child(2) { transition-delay: .1s; }
  .stat-item:nth-child(3) { transition-delay: .2s; }
  .pricing-card:nth-child(2) { transition-delay: .09s; }
  .pricing-card:nth-child(3) { transition-delay: .18s; }
`;
document.head.appendChild(revealStyle);

// ── Beta Signup Forms ─────────────────────────
//
// Uses Formspree (https://formspree.io) — free for up to 50 submissions/month.
// Setup:
//   1. Create a free account at formspree.io
//   2. Create a new form → copy your form endpoint ID (looks like "xbljqkpw")
//   3. Replace FORMSPREE_ID below with your actual ID
//
const FORMSPREE_ID = 'YOUR_FORMSPREE_ID'; // e.g. 'xbljqkpw'

document.querySelectorAll('.beta-form').forEach(form => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = form.querySelector('input[type="email"]').value.trim();
    if (!email) return;

    const formId   = form.id;
    const sourceId = form.dataset.form;
    const btn      = form.querySelector('button[type="submit"]');
    const successEl = document.getElementById(`beta-success-${sourceId}`);

    btn.disabled = true;
    btn.textContent = 'Submitting…';

    try {
      if (FORMSPREE_ID === 'YOUR_FORMSPREE_ID') {
        // Not configured yet — simulate success so UI works during development
        await new Promise(r => setTimeout(r, 600));
        showBetaSuccess(form, successEl);
        return;
      }

      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: sourceId }),
      });

      if (res.ok) {
        showBetaSuccess(form, successEl);
      } else {
        const data = await res.json();
        const msg = data.errors?.[0]?.message || 'Something went wrong. Please try again.';
        btn.textContent = msg;
        btn.disabled = false;
        setTimeout(() => { btn.textContent = 'Sign up for Beta'; btn.disabled = false; }, 3000);
      }
    } catch {
      btn.textContent = 'Sign up for Beta';
      btn.disabled = false;
    }
  });
});

function showBetaSuccess(form, successEl) {
  form.hidden = true;
  if (successEl) successEl.hidden = false;
}

// ── Donation page logic ───────────────────────
// !! SETUP REQUIRED: Replace with your actual Stripe publishable key !!
const STRIPE_PUBLISHABLE_KEY = 'pk_live_YOUR_STRIPE_PUBLISHABLE_KEY_HERE';

// Preset donation amounts and their Stripe Price IDs (create these in your Stripe dashboard)
// Format: { amount: dollars, priceId: 'price_xxx' }
const DONATION_PRESETS = [
  { amount: 3,  priceId: 'price_REPLACE_WITH_3_DOLLAR_PRICE_ID'  },
  { amount: 5,  priceId: 'price_REPLACE_WITH_5_DOLLAR_PRICE_ID'  },
  { amount: 10, priceId: 'price_REPLACE_WITH_10_DOLLAR_PRICE_ID' },
  { amount: 20, priceId: 'price_REPLACE_WITH_20_DOLLAR_PRICE_ID' },
];

let selectedPreset = null;
let stripe = null;

function initStripe() {
  if (typeof Stripe === 'undefined') return;
  if (STRIPE_PUBLISHABLE_KEY.includes('YOUR_STRIPE')) return; // not configured yet
  stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
}

function initDonation() {
  const amountBtns = document.querySelectorAll('.donation-amount-btn');
  const customInput = document.getElementById('donation-custom');
  const donateBtn   = document.getElementById('donate-btn');

  if (!amountBtns.length) return; // not on pricing page

  // Preset buttons
  amountBtns.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      amountBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedPreset = DONATION_PRESETS[i];
      if (customInput) customInput.value = '';
    });
  });

  // Custom amount clears preset
  if (customInput) {
    customInput.addEventListener('input', () => {
      amountBtns.forEach(b => b.classList.remove('selected'));
      selectedPreset = null;
    });
  }

  // Donate button
  if (donateBtn) {
    donateBtn.addEventListener('click', handleDonate);
  }
}

async function handleDonate() {
  const customInput = document.getElementById('donation-custom');
  const customVal = customInput ? parseFloat(customInput.value) : 0;

  // Determine amount
  const amount = selectedPreset ? selectedPreset.amount : customVal;

  if (!amount || amount < 1) {
    showDonationMessage('Please select or enter a donation amount (minimum $1).', 'error');
    return;
  }

  // If Stripe is not yet configured, show instructions
  if (!stripe || STRIPE_PUBLISHABLE_KEY.includes('YOUR_STRIPE')) {
    showDonationMessage(
      'Stripe is not yet configured. See the README for setup instructions.',
      'info'
    );
    return;
  }

  const btn = document.getElementById('donate-btn');
  btn.disabled = true;
  btn.textContent = 'Redirecting…';

  try {
    if (selectedPreset && selectedPreset.priceId && !selectedPreset.priceId.includes('REPLACE')) {
      // Use Stripe Checkout with a pre-created Price
      const result = await stripe.redirectToCheckout({
        lineItems: [{ price: selectedPreset.priceId, quantity: 1 }],
        mode: 'payment',
        successUrl: window.location.origin + '/gnos-landing/pricing.html?donated=true',
        cancelUrl:  window.location.origin + '/gnos-landing/pricing.html',
      });
      if (result.error) throw new Error(result.error.message);
    } else {
      // Custom amount — use a payment link or server-side session
      // You'll need a small server (e.g. Netlify/Vercel function) to create a checkout session
      // with a custom amount. For now we surface a helpful message.
      showDonationMessage(
        'Custom amounts require a server-side integration. Add a Netlify/Vercel function to create a Stripe Checkout Session.',
        'info'
      );
      btn.disabled = false;
      btn.textContent = 'Donate';
    }
  } catch (err) {
    showDonationMessage(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Donate';
  }
}

function showDonationMessage(msg, type = 'info') {
  let el = document.getElementById('donation-msg');
  if (!el) {
    el = document.createElement('p');
    el.id = 'donation-msg';
    el.style.cssText = 'margin-top:16px; font-size:14px; border-radius:8px; padding:10px 16px;';
    document.getElementById('donate-btn')?.after(el);
  }
  el.textContent = msg;
  el.style.background = type === 'error' ? 'rgba(200,50,50,.1)' : 'rgba(139,94,60,.1)';
  el.style.color = type === 'error' ? '#b33' : 'var(--accent)';
  el.style.border = `1px solid ${type === 'error' ? 'rgba(200,50,50,.25)' : 'rgba(139,94,60,.25)'}`;
}

// ── Donation success banner ───────────────────
function checkDonationSuccess() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('donated') === 'true') {
    const banner = document.createElement('div');
    banner.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:var(--accent); color:#faf6ef; padding:14px 28px;
      border-radius:99px; font-size:15px; font-weight:500;
      box-shadow:0 8px 28px rgba(139,94,60,.35); z-index:9999;
      animation: slideUp .4s ease;
    `;
    banner.textContent = '❤️  Thank you for your support!';
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 6000);

    const style = document.createElement('style');
    style.textContent = '@keyframes slideUp { from { opacity:0; transform:translate(-50%, 16px); } to { opacity:1; transform:translate(-50%, 0); } }';
    document.head.appendChild(style);

    // Clean URL
    history.replaceState({}, '', window.location.pathname);
  }
}

// ── Smooth counter animation ──────────────────
function animateCounters() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    const suffix = el.dataset.suffix || '';
    const duration = 1400;
    const start = performance.now();

    function step(now) {
      const progress = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(ease * target).toLocaleString() + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      animateCounters();
      counterObserver.disconnect();
    }
  });
}, { threshold: 0.5 });

const statsSection = document.querySelector('.stats-row');
if (statsSection) counterObserver.observe(statsSection);

// ── Init ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initStripe();
  initDonation();
  checkDonationSuccess();
});
