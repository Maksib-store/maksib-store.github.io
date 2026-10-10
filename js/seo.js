/* متجر مكسب — SEO utilities. Product data and canonical URLs are updated only for public pages. */
(function () {
  'use strict';
  var BRAND = 'متجر مكسب';
  var ORIGIN = window.location.origin;
  var PATH = window.location.pathname || '/';
  var PRIVATE_FILES = [
    '/login.html', '/register.html', '/cart.html', '/orders.html', '/profile.html',
    '/seller-dashboard.html', '/admin-dashboard.html', '/register-super-admin.html',
    '/404.html', '/help-center.html'
  ];
  var robotsMeta = document.querySelector('meta[name="robots"]');

  function ensureMeta(key, value, isProperty) {
    var selector = isProperty ? 'meta[property="' + key + '"]' : 'meta[name="' + key + '"]';
    var el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(isProperty ? 'property' : 'name', key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', value);
    return el;
  }
  function ensureCanonical(url) {
    var el = document.head.querySelector('link[rel="canonical"]');
    if (!el) {
      el = document.createElement('link');
      el.setAttribute('rel', 'canonical');
      document.head.appendChild(el);
    }
    el.href = url;
  }
  function getCanonical() {
    var url = new URL(window.location.href);
    url.hash = '';
    // Homepage is always canonicalized to the root URL, not /index.html.
    if (url.pathname === '/index.html') return ORIGIN + '/';
    // Search, filters and pagination aren't independent landing pages in this setup.
    if (url.pathname.endsWith('/products.html')) return ORIGIN + '/products.html';
    // Product IDs create distinct product pages; discard other tracking/query params.
    if (url.pathname.endsWith('/product.html')) {
      var id = url.searchParams.get('id');
      return ORIGIN + '/product.html' + (id ? '?id=' + encodeURIComponent(id) : '');
    }
    // Seller page paths are unique; remove page= pagination from canonical URL.
    if (/\/store\/[^/]+\/?$/.test(url.pathname)) return ORIGIN + url.pathname.replace(/\/$/, '');
    return ORIGIN + url.pathname;
  }
  function putJsonLd(id, data) {
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/ld+json';
      el.id = id;
      document.head.appendChild(el);
    }
    // Protect the script element boundary if an API-provided string contains '<'.
    el.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
  }
  function textContent(selector) {
    var el = document.head.querySelector(selector);
    return el ? el.content : '';
  }
  function refresh() {
    var title = document.title || BRAND;
    var description = textContent('meta[name="description"]') || 'تصفح المنتجات في متجر مكسب.';
    var canonical = getCanonical();
    var isPrivate = PRIVATE_FILES.indexOf(PATH) !== -1 || /\/help(?:\/|$)/.test(PATH);
    // Product URLs without an ID are only a template, not an indexable landing page.
    if (PATH.endsWith('/product.html') && !new URLSearchParams(window.location.search).get('id')) isPrivate = true;
    if (isPrivate) {
      if (!robotsMeta) {
        robotsMeta = document.createElement('meta');
        robotsMeta.name = 'robots';
        document.head.appendChild(robotsMeta);
      }
      robotsMeta.content = PATH === '/404.html' ? 'noindex,follow' : 'noindex,nofollow';
      var oldCanonical = document.head.querySelector('link[rel="canonical"]');
      if (oldCanonical) oldCanonical.remove();
    } else {
      ensureCanonical(canonical);
    }
    ensureMeta('og:site_name', BRAND, true);
    ensureMeta('og:title', title, true);
    ensureMeta('og:description', description, true);
    ensureMeta('og:type', PATH.endsWith('/product.html') ? 'product' : 'website', true);
    ensureMeta('og:locale', 'ar_EG', true);
    ensureMeta('og:url', canonical, true);
    ensureMeta('og:image', ORIGIN + '/img/hero/slide-1.webp', true);
    ensureMeta('twitter:card', 'summary_large_image', false);
    ensureMeta('twitter:title', title, false);
    ensureMeta('twitter:description', description, false);
    ensureMeta('twitter:image', ORIGIN + '/img/hero/slide-1.webp', false);
    putJsonLd('maksab-site-schema', {
      '@context': 'https://schema.org',
      '@type': 'OnlineStore',
      name: BRAND,
      alternateName: 'سوق مكسب',
      url: ORIGIN + '/',
      logo: ORIGIN + '/favicon.svg',
      image: ORIGIN + '/img/hero/slide-1.webp'
    });
    putJsonLd('maksab-website-schema', {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: BRAND,
      alternateName: 'سوق مكسب',
      url: ORIGIN + '/'
    });
  }
  function noindex() {
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.content = 'noindex,follow';
    var canonical = document.head.querySelector('link[rel="canonical"]');
    if (canonical) canonical.remove();
  }
  function setProduct(p) {
    if (!p || !p.name) return;
    document.title = String(p.name) + ' | ' + BRAND;
    var desc = String(p.description || ('تفاصيل ' + p.name + ' وسعره وتوفره في ' + BRAND + '.'))
      .replace(/\s+/g, ' ').trim();
    if (desc.length > 300) desc = desc.slice(0, 297) + '...';
    ensureMeta('description', desc, false);
    var id = p._id || p.id || new URLSearchParams(window.location.search).get('id');
    var url = ORIGIN + '/product.html' + (id ? '?id=' + encodeURIComponent(id) : '');
    ensureCanonical(url);
    if (robotsMeta) robotsMeta.content = 'index,follow';
    refresh();
    var rawImages = Array.isArray(p.images) ? p.images : [];
    var images = rawImages.filter(function (src) { return typeof src === 'string' && /^https?:\/\//i.test(src); });
    var price = p.final_price !== undefined && p.final_price !== null ? Number(p.final_price) : Number(p.price);
    var productSchema = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: String(p.name),
      description: desc,
      url: url
    };
    if (images.length) productSchema.image = images;
    if (Number.isFinite(price) && price >= 0) {
      productSchema.offers = {
        '@type': 'Offer',
        priceCurrency: 'EGP',
        price: String(price),
        availability: Number(p.quantity) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        url: url
      };
    }
    putJsonLd('maksab-product-schema', productSchema);
    refresh();
    // refresh() keeps canonical stable and reads the actual page title/description.
    ensureMeta('og:title', document.title, true);
    ensureMeta('og:description', desc, true);
    ensureMeta('og:type', 'product', true);
    if (images.length) {
      ensureMeta('og:image', images[0], true);
      ensureMeta('twitter:image', images[0], false);
    }
  }
  window.MaksabSEO = { refresh: refresh, noindex: noindex, setProduct: setProduct };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
