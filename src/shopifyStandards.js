/**
 * CRO checkpoint reference for Shopify storefront audits.
 *
 * These are the SPECIFIC, OBSERVABLE checkpoints the audit verifies against.
 * The LLM is told to ONLY flag items where there is clear evidence of a
 * specific failure — not to invent generic recommendations like "improve
 * hierarchy" or "enhance product cards". Every recommendation in the report
 * must trace back to one of these checkpoints AND to an observed weakness.
 *
 * Format:
 *   id           - stable identifier, used in feature-detection mapping
 *   text         - the actual checkpoint (verbatim from the merchant's CRO list)
 *   linkedFeature- (optional) key from featureDetection.js — if the feature is
 *                  detected as PRESENT, the LLM must NOT claim this checkpoint
 *                  is failing in an "add it" sense
 *   group        - rough grouping for organisation in the prompt
 */

export const CRO_CHECKPOINTS = {
  general: [
    { id: "g.load_speed",        group: "General",      text: "Main pages (home, landing, product) load quickly (5 seconds or less)." },
    { id: "g.cta_every_page",    group: "General",      text: "Every page has a CTA (including 404 pages, empty result pages, blog posts, about us)." },
    { id: "g.clickable_clarity", group: "General",      text: "Clickable elements are visually obvious (hover states, rounded corners, subtle gradient, underlined links)." },
    { id: "g.cookie_bar",        group: "General",      text: "Cookie notification bar can be closed or approved quickly (under 2 seconds)." },
    { id: "g.wishlist",          group: "General",      text: "Store offers a wishlist as a low-commitment first step.", linkedFeature: "wishlist" },
    { id: "g.cta_verb",          group: "General",      text: "Button and link labels start with a verb (e.g. 'Shop Now')." },
    { id: "g.no_false_affordance", group: "General",    text: "Non-clickable items do not look clickable." },
    { id: "g.spacing",           group: "General",      text: "Sufficient spacing between buttons/forms to prevent misclicks." },
    { id: "g.checkout_upsell",   group: "General",      text: "Upsell between checkout and thank-you page without re-entering payment info." },
    { id: "g.logo_consistent",   group: "General",      text: "Logo is in the same location on every page and links back to home." },
    { id: "g.micro_animations",  group: "General",      text: "Subtle micro-animations (e.g. pulses) emphasise the main CTA." },
    { id: "g.no_early_popups",   group: "General",      text: "No annoying pop-ups that fire too early in the journey." },
    { id: "g.sitewide_offer_bar",group: "General",      text: "Site-wide offer bar (e.g. Free Shipping) is prominent at the top with urgency/scarcity and a linked CTA.", linkedFeature: "announcementBar" }
  ],
  navigation: [
    { id: "n.broad_shallow",     group: "Navigation",   text: "Navigation is broad and shallow (many items per level), not deep." },
    { id: "n.active_state",      group: "Navigation",   text: "Active-state feedback shows the user where they are." },
    { id: "n.labels_accurate",   group: "Navigation",   text: "Category labels accurately describe the category contents." },
    { id: "n.ordered_logically", group: "Navigation",   text: "Navigation items are ordered task-first; corporate links pushed to the bottom." },
    { id: "n.no_clutter",        group: "Navigation",   text: "Main nav doesn't include privacy/return/terms links." }, 
    { id: "n.sticky_nav",        group: "Navigation",   text: "Sticky nav keeps categories, search, and cart accessible while scrolling.", linkedFeature: "stickyHeader" } 
  ],
  search: [
    { id: "s.prominent",         group: "Search",       text: "Prominent search box near top (or top-right) of the site.", linkedFeature: "searchBar" },  
    { id: "s.autocomplete",      group: "Search",       text: "Search bar has auto-complete and auto-suggest." },
    { id: "s.categories_too",    group: "Search",       text: "Auto-suggest searches categories AND products." },
    { id: "s.results_clear",     group: "Search",       text: "Results page shows the query, is editable and re-submittable." },
    { id: "s.ranked_relevance",  group: "Search",       text: "Results are ranked by relevance and show count." },
    { id: "s.no_results_help",   group: "Search",       text: "Empty results offer ideas / suggestions for improving the query." },
    { id: "s.hints_examples",    group: "Search",       text: "Hints, templates, or example queries are shown." },
    { id: "s.recent_trending",   group: "Search",       text: "On focus, search shows recent or trending searches." },
    { id: "s.spell_synonyms",    group: "Search",       text: "Automatic spell-check, plurals, and synonym handling." },
    { id: "s.magnifier_icon",    group: "Search",       text: "Magnifying-glass icon clearly indicates search." }
  ],
  cartWidget: [
    { id: "cw.accessible",       group: "Cart Widget",  text: "Cart widget accessible on every page (top-right).", linkedFeature: "cartDrawer" },
    { id: "cw.mini_cart_detail", group: "Cart Widget",  text: "Mini cart shows total, discount, item count, and items on hover." },
    { id: "cw.free_ship_progress", group: "Cart Widget", text: "Free-shipping threshold progress is visible from the cart widget.", linkedFeature: "freeShippingBar" },
    { id: "cw.basket_checkout",  group: "Cart Widget",  text: "Links to both basket and checkout are clearly visible in the mini-cart." },
    { id: "cw.empty_state_cta",  group: "Cart Widget",  text: "Empty cart widget has a CTA to 'Shop our best-sellers'." }
  ],
  footer: [
    { id: "f.benefits",          group: "Footer",       text: "Footer reiterates benefits (free shipping, returns, money back, shipped this month, contact info)." },
    { id: "f.back_to_top",       group: "Footer",       text: "Footer has a 'Back to top' link.", linkedFeature: "backToTop" }, 
    { id: "f.real_org",          group: "Footer",       text: "Footer makes it clear a real organisation is behind the site (address or office photo)." },
    { id: "f.policies",          group: "Footer",       text: "Return policy, privacy policy, and T&Cs are reachable in one click." },
    { id: "f.trust_seals",       group: "Footer",       text: "Footer shows trust icons / seal badges with reassuring copy." },
    { id: "f.social_followers",  group: "Footer",       text: "Footer links to social networks with follower counts." },
    { id: "f.main_categories",   group: "Footer",       text: "Footer links to main categories." }
  ],
  home: [
    { id: "h.offer_top",         group: "Home / General", text: "Home page promotes site-wide offers at the top (e.g. Free Shipping) with urgency/scarcity triggers.", linkedFeature: "announcementBar" },
    { id: "h.professional",      group: "Home / General", text: "Home page is professionally designed, not overloaded, and creates a positive first impression." },
    { id: "h.product_identity",  group: "Home / General", text: "It's immediately clear what the store sells once a visitor lands on the home page." },
    { id: "h.hierarchy",         group: "Home / General", text: "Home page follows a clear, straightforward visual hierarchy." },
    { id: "h.value_prop",        group: "Home / General", text: "Value proposition is clearly stated (tagline or welcome blurb)." },
    { id: "h.quality_graphics",  group: "Home / Content", text: "Home page uses meaningful high-quality graphics, not clip art or stock-model photos." },
    { id: "h.primary_ctas",      group: "Home / Content", text: "One or two visually prominent CTAs above the fold with relevant copy (e.g. 'Start shopping')." },
    { id: "h.deals_promos",      group: "Home / Content", text: "Specific deals, special offers, or urgency offers are highlighted near the top." },
    { id: "h.brand_benefits",    group: "Home / Content", text: "Main benefits of shopping (e.g. vegan, charity, ethics, 'X products shipped this month') are highlighted.", linkedFeature: "trustSignals" },
    { id: "h.top_categories",    group: "Home / Content", text: "Most important product categories are shown first with descriptive photos near the top.", linkedFeature: "featuredProducts" },
    { id: "h.special_pages",     group: "Home / Content", text: "Special category pages (best-sellers, new, sale, '30% off') are used to put users in shopping mode." },
    { id: "h.featured_products", group: "Home / Content", text: "Short list of important products with links is on the home page.", linkedFeature: "featuredProducts" },
    { id: "h.contact_option",    group: "Home / Content", text: "Home page provides a way to contact the store (chat, email, or phone).", linkedFeature: "liveChat" },
    { id: "h.recently_viewed",   group: "Home / Content", text: "Recently viewed items are shown to returning visitors.", linkedFeature: "recentlyViewed" },
    { id: "h.founder_story",     group: "Home / Content", text: "Founder story / mission / vision is shown.", linkedFeature: "brandStory" },
    { id: "h.customer_reviews",  group: "Home / Social Proof", text: "Customer reviews appear on the home page with links to the product.", linkedFeature: "reviews" },
    { id: "h.store_ratings",     group: "Home / Social Proof", text: "Overall store ratings from authoritative review sites (Trustpilot, Reviews.com, Yotpo, Podium) are shown." },
    { id: "h.awards_badges",     group: "Home / Social Proof", text: "Awards, trust badges, and certificates earned by the store are shown.", linkedFeature: "trustSignals" },
    { id: "h.press_logos",       group: "Home / Social Proof", text: "Press / blog / celebrity logos with brand exposure are highlighted (e.g. 'As seen on', 'bestseller on Amazon/Flipkart').", linkedFeature: "pressStrip" },
    { id: "h.brand_logos",       group: "Home / Social Proof", text: "Logos of well-known brands the store carries are shown." },
    { id: "h.ugc_photos",        group: "Home / Social Proof", text: "User-generated photos (e.g. Instagram) are shown." }
  ],
  collection: [
    { id: "c.sort_options",      group: "Collection / General", text: "Users can sort by price, best-sellers, newest, most popular, most discounted.", linkedFeature: "sort" },
    { id: "c.sort_position",     group: "Collection / General", text: "Sort control is in the top-right above the product grid." },
    { id: "c.category_names",    group: "Collection / General", text: "Category and sub-category names are clear and understandable." },
    { id: "c.grid_vs_list",      group: "Collection / General", text: "Right view type used: grid when image is the decision factor, list when attributes are." },
    { id: "c.product_count",     group: "Collection / General", text: "Exact number of products per page is shown (filtered or not)." },
    { id: "c.seo_description",   group: "Collection / General", text: "A ~400-word category description sits at top (Read-more collapsed) or at the bottom for SEO." },
    { id: "c.scroll_position",   group: "Collection / General", text: "Vertical scroll position is preserved when navigating back from a product page." },

    { id: "c.cards_per_row",     group: "Collection / Cards", text: "3–4 relevant products per row." },
    { id: "c.cards_default_sort",group: "Collection / Cards", text: "Trending / top-rated / best-selling items appear first by default." },
    { id: "c.hover_secondary_img", group: "Collection / Cards", text: "Additional product photos appear on mouse hover.", linkedFeature: "productCardHover" },
    { id: "c.consistent_imagery",group: "Collection / Cards", text: "Image style (background, framing, sizing, angle) is consistent for scannability." },
    { id: "c.consistent_card_size", group: "Collection / Cards", text: "Product card size is consistent across the grid." },
    { id: "c.card_variants",     group: "Collection / Cards", text: "Available variants (size, colour) are clearly shown on each card.", linkedFeature: "variantSwatches" },
    { id: "c.card_essentials",   group: "Collection / Cards", text: "Card shows: title, old price, new price, discount, review count, overall rating, variants, attributes, short description." },
    { id: "c.card_cta",          group: "Collection / Cards", text: "A CTA appears on hover to drive click-through to the product page." },
    { id: "c.scarcity_badge",    group: "Collection / Cards", text: "Scarcity is shown on low-stock items ('Only 1 left')." },
    { id: "c.out_of_stock",      group: "Collection / Cards", text: "Out-of-stock items show 'You just missed it' (reinforces scarcity)." },
    { id: "c.badges",            group: "Collection / Cards", text: "Badges on cards (Best-seller, New, Top choice, Trending, Fast delivery, On sale)." },
    { id: "c.notify_when_back",  group: "Collection / Cards", text: "Email-when-available capture for out-of-stock products.", linkedFeature: "backInStockNotify" },

    { id: "c.filters_useful",    group: "Collection / Filters", text: "Filters are easy to understand and useful (especially on mobile).", linkedFeature: "filtering" },
    { id: "c.filters_prominent", group: "Collection / Filters", text: "Filters are prominent enough for filter-prone categories." },
    { id: "c.filters_popular",   group: "Collection / Filters", text: "Most popular filters are shown at the top." },
    { id: "c.filters_relevant",  group: "Collection / Filters", text: "Only filters relevant to the category are shown (e.g. screen size for monitors)." },
    { id: "c.filters_chips",     group: "Collection / Filters", text: "Applied filters are clearly visible (chip count) and easy to remove." },
    { id: "c.filters_multi",     group: "Collection / Filters", text: "Multiple filters can be applied at once." },
    { id: "c.filters_position",  group: "Collection / Filters", text: "Filters are placed in standard position (left rail or top bar)." },
    { id: "c.filters_ajax",      group: "Collection / Filters", text: "Grid auto-updates in real-time when a filter changes (no full reload)." },
    { id: "c.filters_sticky",    group: "Collection / Filters", text: "Filter controls are sticky and reachable while scrolling." },
    { id: "c.filters_widgets",   group: "Collection / Filters", text: "Right widgets per filter type (colour swatches, price range slider with typed min/max)." }
  ],
  product: [
    { id: "p.sticky_buy",        group: "Product / General", text: "Sticky nav with product title, image, sections, availability, prices, discount, and CTA that hides on scroll-down and reappears on scroll-up.", linkedFeature: "stickyAddToCart" },
    { id: "p.questions",         group: "Product / General", text: "Customers can ask questions (chat, phone, contact).", linkedFeature: "liveChat" },
    { id: "p.breadcrumbs",       group: "Product / General", text: "Breadcrumbs are present (not applicable to single-product stores or direct-response landing pages).", linkedFeature: "breadcrumbs" },
    { id: "p.notify_in_stock",   group: "Product / General", text: "Email-when-back-in-stock capture for unavailable variants.", linkedFeature: "backInStockNotify" },
    { id: "p.back_navigation",   group: "Product / General", text: "Back button returns the user to where they came from (preserves scroll & filters)." },

    { id: "p.title_descriptive", group: "Product / Overview", text: "Product titles are descriptive." },
    { id: "p.title_prominent",   group: "Product / Overview", text: "Main title is visually prominent vs other content." },
    { id: "p.title_length",      group: "Product / Overview", text: "Title is under 65 characters (so it isn't truncated in Google results)." },
    { id: "p.subtitle_benefits", group: "Product / Overview", text: "Subtitle highlights a key benefit and uses power words ('effortless', 'unique', 'exclusive')." },
    { id: "p.rating_near_title", group: "Product / Overview", text: "Star rating is near the title and click-scrolls to the reviews section.", linkedFeature: "reviews" },
    { id: "p.benefit_list",      group: "Product / Overview", text: "Short list of key benefits near the title, linked to detailed description (with check arrows)." },

    { id: "p.main_photo",        group: "Product / Gallery", text: "Main product photo is attractive." },
    { id: "p.zoom",              group: "Product / Gallery", text: "Main photo can be zoomed easily (especially on mobile).", linkedFeature: "productMediaZoom" },
    { id: "p.multiple_photos",   group: "Product / Gallery", text: "Gallery contains multiple product photos." },
    { id: "p.thumbnails",        group: "Product / Gallery", text: "Gallery shows thumbnails of available images." },
    { id: "p.video",             group: "Product / Gallery", text: "Gallery contains product video(s).", linkedFeature: "productVideo" },
    { id: "p.gallery_arrows",    group: "Product / Gallery", text: "Gallery has arrow navigation between images." },
    { id: "p.swipe_mobile",      group: "Product / Gallery", text: "Gallery supports swipe on mobile." },
    { id: "p.variant_images",    group: "Product / Gallery", text: "Images exist for different variants / sizes." },

    { id: "p.main_cta",          group: "Product / CTA", text: "Main CTA is the most visible element and contains a cart icon." },
    { id: "p.variant_touch",     group: "Product / CTA", text: "Variants are mobile-friendly with enough white space to avoid misclicks.", linkedFeature: "variantSwatches" },
    { id: "p.variant_gallery_link", group: "Product / CTA", text: "Variant selection swaps the gallery image to match." },
    { id: "p.select_reminder",   group: "Product / CTA", text: "Visible reminder if the user clicks 'add to cart' without picking a size/colour." },
    { id: "p.interactive_variants", group: "Product / CTA", text: "Interactive variant selectors (price and image update without page reload)." },
    { id: "p.size_chart",        group: "Product / CTA", text: "Size chart link/popup near size selectors (for sized products).", linkedFeature: "sizeGuide" },
    { id: "p.localized_units",   group: "Product / CTA", text: "Localised units (cm/inch, kg/lb) shown for sized products." }, 
    { id: "p.model_size",        group: "Product / CTA", text: "Apparel mentions model height and the size the model is wearing." },
    { id: "p.quantity_interactive", group: "Product / CTA", text: "Quantity selector is interactive (not a dropdown), updates price in real time." },
    { id: "p.cta_copy",          group: "Product / CTA", text: "CTA copy explains what happens next ('Proceed to secure checkout')." },
    { id: "p.cart_feedback",     group: "Product / CTA", text: "Clear feedback when product added to cart (mini-cart count increases)." },
    { id: "p.cta_state_change",  group: "Product / CTA", text: "CTA changes state after adding ('✓ Added to cart' → 'Go to my cart →')." },
    { id: "p.price_prominent",   group: "Product / CTA", text: "Price is prominent, especially when discounted." },
    { id: "p.price_near_cta",    group: "Product / CTA", text: "Price is placed near the main CTA." },
    { id: "p.localized_price",   group: "Product / CTA", text: "Price is localised to visitor's currency.", linkedFeature: "currencySelector" },
    { id: "p.cta_distinct_bg",   group: "Product / CTA", text: "Primary CTA background differs from surrounding elements." },
    { id: "p.charges_disclosed", group: "Product / CTA", text: "Additional charges (shipping, VAT) are disclosed near the main CTA." },
    { id: "p.free_ship_callout", group: "Product / CTA", text: "Free shipping (if offered) is highlighted near the main CTA.", linkedFeature: "freeShipCallout" },
    { id: "p.shipping_info",     group: "Product / CTA", text: "Shipping info (location, country flag, cost, time) is shown near CTA." },
    { id: "p.availability",      group: "Product / CTA", text: "Stock status ('In stock') is shown near the main CTA.", linkedFeature: "stockIndicator" },
    { id: "p.discount_strike",   group: "Product / CTA", text: "Strike-through old price + new price + savings (% or $) shown for sale items." },
    { id: "p.returns_info",      group: "Product / CTA", text: "Returns, refunds, and money-back guarantee info is clearly shown.", linkedFeature: "returnsGuarantee" },
    { id: "p.express_payments",  group: "Product / CTA", text: "Express payments offered (PayPal, Amazon, Google Pay, Apple Pay) for direct-response pages." },
    { id: "p.installments",      group: "Product / CTA", text: "Installment payments (Klarna, AfterPay) offered for expensive products." },

    { id: "p.press_logos",       group: "Product / Social Proof", text: "Press/blog/celebrity logos with PR exposure are shown.", linkedFeature: "trustSignals" },
    { id: "p.detailed_reviews",  group: "Product / Social Proof", text: "Reviews show title, customer product photos, stars, reviewer photo, name, 'verified' tag, occupation, age.", linkedFeature: "reviews" },
    { id: "p.reviews_stand_out", group: "Product / Social Proof", text: "Reviews visually stand out (e.g. slightly yellow background)." },
    { id: "p.customer_photos",   group: "Product / Social Proof", text: "Photos (with faces) of happy customers using the product." },
    { id: "p.rating_filter",     group: "Product / Social Proof", text: "Overall rating shown and filterable by star count." },
    { id: "p.customer_count",    group: "Product / Social Proof", text: "Number of customers this week/month/all-time shown ('19,222 shipped this month')." },
    { id: "p.video_testimonials",group: "Product / Social Proof", text: "Video testimonials are included." },
    { id: "p.social_followers",  group: "Product / Social Proof", text: "Facebook / Twitter follower counts shown." },

    { id: "p.quantity_discount", group: "Product / Boosters", text: "Quantity discounts shown near CTA (1x, 2x, 3x with 'Top choice', 'Best value' badges).", linkedFeature: "quantityBreaks" },
    { id: "p.cross_upsell",      group: "Product / Boosters", text: "Relevant cross-sell / up-sell products offered.", linkedFeature: "relatedProducts" },
    { id: "p.bundles",           group: "Product / Boosters", text: "Bundle products offered with prominent discounts.", linkedFeature: "productBundle" },
    { id: "p.subscription",      group: "Product / Boosters", text: "Subscription / subscribe-and-save offered for replenishable products (boosts LTV).", linkedFeature: "subscription" },
    { id: "p.urgency",           group: "Product / Boosters", text: "Urgency triggers near CTA ('Today only', 'Ship today if ordered in 12 min').", linkedFeature: "urgency" },
    { id: "p.scarcity",          group: "Product / Boosters", text: "Scarcity triggers near CTA ('Only 3 products left').", linkedFeature: "stockIndicator" },
    { id: "p.viewed_today",      group: "Product / Boosters", text: "Live counters showing views/purchases in last 24 hours." },
    { id: "p.charity",           group: "Product / Boosters", text: "If a percentage of profit goes to charity, this is highlighted." },
    { id: "p.also_viewed",       group: "Product / Boosters", text: "'Visitors who viewed this also viewed…' surfaces complementary or alternatives.", linkedFeature: "relatedProducts" },

    { id: "p.desc_readable",     group: "Product / Description", text: "Description is easy to read (font size, contrast, single column, ~75ch lines, 1.5 line-height, max 4 lines per block)." },
    { id: "p.desc_scannable",    group: "Product / Description", text: "Information is scannable (grouped, bulleted, benefits highlighted)." },
    { id: "p.desc_accordion",    group: "Product / Description", text: "Long sections ('General', 'Technical info') are grouped in mobile-friendly accordions." },
    { id: "p.section_benefits",  group: "Product / Description", text: "Section titles describe benefits, not features." },
    { id: "p.what_included",     group: "Product / Description", text: "Everything included in the product is shown (ideally with photos)." },
    { id: "p.faqs",              group: "Product / Description", text: "Product page contains customer FAQs (product-specific + store-wide).", linkedFeature: "productFaq" },
    { id: "p.tech_table",        group: "Product / Description", text: "Technical specification table is readable (alternating row colours, hover state, sensible spacing)." },
    { id: "p.compare",           group: "Product / Description", text: "Product comparisons are offered." }, 
    { id: "p.how_to_use",        group: "Product / Description", text: "How to use the product in 3 easy steps." },
    { id: "p.social_embeds",     group: "Product / Description", text: "Embedded social-network reviews / screenshots (Facebook, IG, Twitter, WhatsApp)." }
  ],
  cart: [
    { id: "ct.uncluttered",      group: "Cart / General", text: "Cart design is clear and uncluttered." },
    { id: "ct.urgency",          group: "Cart / General", text: "Urgency triggers ('Items reserved for 10 minutes', 'Ship today if ordered in 12 min')." },
    { id: "ct.free_ship_progress",group: "Cart / General", text: "Cart shows distance from free-shipping (or discount) threshold.", linkedFeature: "freeShippingBar" },
    { id: "ct.free_ship_unlocked",group: "Cart / General", text: "When threshold is reached, this is prominently highlighted (bold, green)." },
    { id: "ct.persisted",        group: "Cart / General", text: "Items in the cart persist when the user returns." },
    { id: "ct.item_info",        group: "Cart / General", text: "All key info shown per item (title, image, variant, quantity, price)." },
    { id: "ct.variant_image",    group: "Cart / General", text: "Cart shows the correct image for the chosen variant." },
    { id: "ct.qty_change",       group: "Cart / General", text: "Quantity can be changed inline; total auto-updates." },
    { id: "ct.remove_item",      group: "Cart / General", text: "Items can be easily removed." },
    { id: "ct.delivery_date",    group: "Cart / General", text: "Cart shows expected delivery day." },
    { id: "ct.scarcity",         group: "Cart / General", text: "Scarcity per item ('Only 1 in stock') in a prominent colour." },
    { id: "ct.help_center",      group: "Cart / General", text: "Cart offers easy access to help (chat / email / phone).", linkedFeature: "liveChat" },
    { id: "ct.returns_info",     group: "Cart / General", text: "Returns / refunds / money-back info shown (small popup, not full redirect)." },
    { id: "ct.coupon_field",     group: "Cart / General", text: "Coupon code field exists but is hidden by default (so users don't search Google for codes)." },
    { id: "ct.cart_upsell",      group: "Cart / General", text: "Cart shows inexpensive upsell / cross-sell with urgency and discount.", linkedFeature: "relatedProducts" },
    { id: "ct.save_for_later",   group: "Cart / General", text: "Save for later option instead of delete." },

    { id: "ct.subtotal",         group: "Cart / CTA", text: "Subtotal is prominent and near the main CTA." },
    { id: "ct.taxes",            group: "Cart / CTA", text: "Estimated taxes are shown." },
    { id: "ct.savings",          group: "Cart / CTA", text: "Total savings on the purchase are shown near CTA." },
    { id: "ct.cta_copy",         group: "Cart / CTA", text: "Main CTA ('Proceed to secure checkout') is prominent and duplicated at top & bottom." },
    { id: "ct.lock_icon",        group: "Cart / CTA", text: "Main CTA shows a lock icon on a distinctive background." },
    { id: "ct.trust_seal",       group: "Cart / CTA", text: "Trust icon / seal badge below CTA with reassuring copy ('Shop with confidence').", linkedFeature: "trustSignals" },
    { id: "ct.alt_payments",     group: "Cart / CTA", text: "Alternative payments shown below CTA (PayPal, Amazon, Google Pay)." },
    { id: "ct.installment_imgs", group: "Cart / CTA", text: "Images of installment options with monthly amount and duration." },
    { id: "ct.continue_shopping",group: "Cart / CTA", text: "Secondary 'Continue shopping' CTA on the cart page." } 
  ]
};

/**
 * Format the CRO checklist for a single page area as bullet text.
 * Used by auditPrompt.js to ground the LLM in concrete checkpoints.
 */
export function formatCheckpointList(area) {
  const list = CRO_CHECKPOINTS[area] || [];
  if (!list.length) return "(no checkpoints defined for this area)";

  // Group by .group for readability
  const grouped = new Map();
  for (const cp of list) {
    if (!grouped.has(cp.group)) grouped.set(cp.group, []);
    grouped.get(cp.group).push(cp);
  }

  const lines = [];
  for (const [group, items] of grouped) {
    lines.push(`  ${group}:`);
    for (const it of items) {
      const tag = it.linkedFeature ? ` [linkedFeature: ${it.linkedFeature}]` : "";
      lines.push(`    - ${it.text}${tag}`);
    }
  }
  return lines.join("\n");
}

/**
 * Backward-compat shim — the old shape used by some callers.
 */
export const SHOPIFY_STANDARDS = {
  homePage:       { standards: CRO_CHECKPOINTS.home },
  collectionPage: { standards: CRO_CHECKPOINTS.collection },
  productPage:    { standards: CRO_CHECKPOINTS.product },
  cartPage:       { standards: CRO_CHECKPOINTS.cart },
  general:        { standards: CRO_CHECKPOINTS.general },
  navigation:     { standards: CRO_CHECKPOINTS.navigation },
  search:         { standards: CRO_CHECKPOINTS.search },
  cartWidget:     { standards: CRO_CHECKPOINTS.cartWidget },
  footer:         { standards: CRO_CHECKPOINTS.footer }
};

export function getShopifyReference(category, item) {
  return SHOPIFY_STANDARDS[category]?.[item] || null;
}

/**
 * Canonical content-section vocabulary used by the storefront section
 * inventory (see crawler.js `extractSectionInventory`). Page chrome
 * (header/footer/announcement/cart/popups) is intentionally NOT in this list —
 * those are handled by featureDetection.js.
 */
export const SECTION_LABELS = {
  hero:                   "Hero / banner / slideshow",
  featuredCollection:     "Featured collection (product showcase)",
  collectionList:         "Collection / category list",
  featuredProduct:        "Featured single product",
  productRecommendations: "Recommended / related products",
  benefits:               "Value-prop / benefits / icon row",
  imageWithText:          "Image-with-text / editorial block",
  brandStory:             "Brand story / about / mission",
  richText:               "Rich-text content block",
  testimonials:           "Testimonials / customer reviews block",
  press:                  "Press / 'as seen in' / brand logos",
  newsletter:             "Newsletter / email signup",
  blog:                   "Blog / articles teaser",
  gallery:                "Gallery / lookbook / UGC / Instagram",
  video:                  "Video section",
  contact:                "Contact form / contact block",
  faq:                    "FAQ / accordion",
  countdown:              "Countdown / promo / urgency",
  map:                    "Map / store locator",
  custom:                 "Custom / app section"
};

/**
 * Sections a well-converting Shopify page of each type is expected to contain,
 * with the CRO reason each one matters. This is the baseline used to detect
 * MISSING sections (present-vs-expected diff). Each reason traces to a
 * checkpoint already defined in CRO_CHECKPOINTS above, so a "missing section"
 * finding is always grounded in a real standard — never invented.
 *
 * NOTE: only types where absence is reliably observable from a single crawl are
 * listed. We deliberately keep this conservative to avoid false "missing" flags
 * on stores that simply use a different (but valid) layout.
 */
export const EXPECTED_SECTIONS = {
  home: {
    hero:               "First impression — must make clear what the store sells (h.product_identity).",
    benefits:           "Value-prop / benefits row reassures on shipping, returns, guarantees (h.brand_benefits).",
    featuredCollection: "Puts visitors into shopping mode with top products/categories (h.top_categories, h.featured_products).",
    testimonials:       "On-home social proof builds trust before the product page (h.customer_reviews).",
    brandStory:         "Founder / mission section builds brand credibility (h.founder_story).",
    newsletter:         "Email capture converts visitors who are not ready to buy (g.cta_every_page)."
  },
  product: {
    productRecommendations: "Cross-sell / 'also viewed' lifts average order value (p.cross_upsell, p.also_viewed).",
    testimonials:           "Product-level reviews are the single biggest conversion driver (p.detailed_reviews).",
    faq:                    "Product FAQs pre-empt purchase objections at the decision point (p.faqs)."
  }
};