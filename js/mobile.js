// Mobile sidebar toggle — included on all pages
(function() {
  // Create topbar if on mobile
  function initMobile() {
    if (window.innerWidth > 768) return;

    const sidebar = document.querySelector('.sidebar');
    const layout = document.querySelector('.layout');
    if (!sidebar || !layout) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Create mobile topbar
    const topbar = document.createElement('div');
    topbar.className = 'mobile-topbar';
    topbar.innerHTML = `
      <button class="mobile-menu-btn" id="menuBtn" aria-label="Open menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      </button>
      <span class="mobile-topbar-logo">DRIX Admin</span>
      <div style="width:22px;"></div>
    `;

    // Insert topbar before main-content
    const main = document.querySelector('.main-content');
    if (main) layout.insertBefore(topbar, main);

    // Toggle sidebar
    document.getElementById('menuBtn').addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('show');
    });

    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    });

    // Close on link click
    sidebar.querySelectorAll('.sidebar-link').forEach(link => {
      link.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('show');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobile);
  } else {
    initMobile();
  }
})();
