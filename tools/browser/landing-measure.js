// Measure the shipped landing page in a real browser. Evaluated by tools/browser_probe.js after
// the viewport is set; every value is read from the settled layout, not from the markup.
(() => {
    const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
            x: Math.round(box.x), y: Math.round(box.y),
            w: Math.round(box.width), h: Math.round(box.height),
            right: Math.round(box.right), bottom: Math.round(box.bottom)
        };
    };
    const section = document.getElementById('popit');
    if (!section) return { ok: false, failures: ['#popit section is missing'] };

    const root = section.querySelector('.popit-root');
    const child = section.querySelector('.popit-child');
    const rows = Array.from(section.querySelectorAll('.popit-row'));
    const pairs = Array.from(section.querySelectorAll('.popit-pair'));
    const bands = Array.from(section.querySelectorAll('.popit-band'));
    const planes = Array.from(section.querySelectorAll('.popit-planes tbody tr'));
    const rootBox = rect(root);
    const childBox = rect(child);
    const overlap = !(
        rootBox.right <= childBox.x || childBox.right <= rootBox.x ||
        rootBox.bottom <= childBox.y || childBox.bottom <= rootBox.y
    );
    const bandColors = bands.slice(0, 3).map((band) =>
        Array.from(band.children).map((cell) => getComputedStyle(cell).backgroundColor));

    return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        root: rootBox,
        child: childBox,
        rows: rows.length,
        pairs: pairs.length,
        bands: bands.length,
        bandHeights: bands.map((band) => rect(band).h),
        bandColors,
        bandChildren: bands.map((band) => band.children.length),
        planes: planes.length,
        overlap,
        sectionHeight: rect(section).h,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        rootVisible: getComputedStyle(root).visibility === 'visible' && getComputedStyle(root).display !== 'none',
        childVisible: getComputedStyle(child).visibility === 'visible' && getComputedStyle(child).display !== 'none',
        pairText: (section.innerText || '').length
    };
})()
