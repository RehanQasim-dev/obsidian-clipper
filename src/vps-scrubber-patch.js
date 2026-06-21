// Injected into the PAGE (main world) by video-player-stage.ts as a
// web-accessible resource — NOT inline, because YouTube's CSP blocks inline
// scripts injected by content scripts, which silently disabled this patch and
// left the scrubber misaligned while the player is scaled.
//
// While a side panel is open we scale the live player down with a CSS transform.
// YouTube's seek math mixes physical pointer coords (clientX/Y, affected by the
// transform) with the bar's *layout* width (offsetWidth, unaffected), so clicks
// land at position×scale. We un-scale MouseEvent/PointerEvent coordinates for
// events targeting #movie_player back into layout space so seeking is accurate.
// The scale/offset are published by the content script on document.body.dataset.
(function () {
	if (window.__obVpsPatched) return;
	window.__obVpsPatched = true;

	function patchEventProperty(proto, propName, isY) {
		const origDesc = Object.getOwnPropertyDescriptor(proto, propName);
		if (!origDesc || !origDesc.get) return;
		Object.defineProperty(proto, propName, {
			configurable: true,
			get: function () {
				const val = origDesc.get.call(this);
				const scaleStr = document.body && document.body.dataset.obVpsScale;
				if (!scaleStr) return val;

				let target = this.target;
				if (target && target.nodeType === 3) target = target.parentNode;
				if (!target || !target.closest) return val;
				if (!target.closest('#movie_player')) return val;

				const scale = parseFloat(scaleStr);
				if (scale === 1) return val;

				const baseLeft = parseFloat(document.body.dataset.obVpsLeft || '0');
				const baseTop = parseFloat(document.body.dataset.obVpsTop || '0');
				const centerDy = parseFloat(document.body.dataset.obVpsDy || '0');

				if (isY) {
					let cy = val;
					if (propName === 'pageY') cy -= window.scrollY;
					const unscaled = (cy - (baseTop + centerDy)) / scale + baseTop;
					return propName === 'pageY' ? unscaled + window.scrollY : unscaled;
				} else {
					let cx = val;
					if (propName === 'pageX') cx -= window.scrollX;
					const unscaled = (cx - baseLeft) / scale + baseLeft;
					return propName === 'pageX' ? unscaled + window.scrollX : unscaled;
				}
			},
		});
	}

	// Patch on MouseEvent.prototype; PointerEvent inherits these accessors.
	['clientX', 'pageX', 'x'].forEach((p) => patchEventProperty(MouseEvent.prototype, p, false));
	['clientY', 'pageY', 'y'].forEach((p) => patchEventProperty(MouseEvent.prototype, p, true));
	// If PointerEvent overrides any of them with its own accessor, patch those too.
	if (typeof PointerEvent !== 'undefined') {
		['clientX', 'pageX', 'x'].forEach((p) => {
			if (Object.getOwnPropertyDescriptor(PointerEvent.prototype, p)) patchEventProperty(PointerEvent.prototype, p, false);
		});
		['clientY', 'pageY', 'y'].forEach((p) => {
			if (Object.getOwnPropertyDescriptor(PointerEvent.prototype, p)) patchEventProperty(PointerEvent.prototype, p, true);
		});
	}
})();
