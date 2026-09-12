import type { SiteConfig } from "./types";

// EVERYTHING on the site comes from here. Fill it from the CRM; see README.
// This example is deliberately generic so the gate can be run on the starter
// itself. Replace every value.
export const site: SiteConfig = {
  url: "https://example.com",
  business: {
    name: "Example Roofing Co.",
    schemaType: "RoofingContractor",
    phone: "555-010-0100",
    email: "hello@example.com",
    address: { city: "Springfield", region: "MO", country: "US" },
    serviceArea: ["Springfield", "Nixa", "Ozark", "Republic"],
    sameAs: ["https://www.facebook.com/example"],
    logo: undefined,
    hours: ["Mo-Fr 07:00-18:00", "Sa 08:00-12:00"],
  },
  brand: {
    colors: {
      ground: "#f7f4ee",
      surface: "#ffffff",
      text: "#1d1a16",
      muted: "#6b6459",
      primary: "#1f3a5f",
      primaryHover: "#16293f",
      accent: "#c8642a",
    },
    fonts: { display: "Space Grotesk", body: "Inter" },
    tagline: "Roofs built to outlast the weather.",
    positioning:
      "Family-run roofing contractor serving Springfield and the surrounding towns with its own crews, start to finish.",
    cta: { label: "Get a free estimate", href: "/contact/" },
    hardRules: [
      "One phone number: 555-010-0100.",
      "Never quote or imply pricing.",
      "Never state years in business until confirmed.",
    ],
  },
  facts: [
    { label: "Service area", value: "Springfield, Nixa, Ozark and Republic, Missouri", source: "https://example.com/" },
    { label: "Phone", value: "555-010-0100", source: "https://example.com/contact/" },
    { label: "Crews", value: "All work self-performed by our own crews", source: "https://www.facebook.com/example" },
  ],
  services: [
    {
      slug: "roof-replacement",
      name: "Roof Replacement",
      primaryKeyword: "roof replacement Springfield MO",
      description:
        "Full roof replacement in Springfield, MO — tear-off, decking repair, underlayment and architectural shingles, installed by our own crews.",
      question: "What does a roof replacement in Springfield involve?",
      answer:
        "A roof replacement removes the existing shingles down to the decking, repairs any damaged boards, installs new underlayment and flashing, and lays new architectural shingles. In Springfield most homes take one to two days. We handle the permit, the tear-off haul-away and the final inspection walk-through with you.",
      body: [
        "Every replacement starts with a walk on the roof and a written scope you can read in five minutes. No line item goes on it that we cannot point to.",
        "We install what the manufacturer specifies, in the order they specify it, so the warranty they offer actually holds.",
      ],
      faqs: [
        { q: "How long does a roof replacement take?", a: "Most single-family roofs in Springfield are torn off and replaced in one to two working days. Larger or steeper roofs, or decking that needs repair, can add a day. We tell you the expected schedule before we start and call the same day if it changes." },
        { q: "Do I need to be home during the work?", a: "No. We need access to the driveway for the dumpster and material delivery, and a phone number to reach you. Most customers are at work during the install and walk the finished roof with us that evening or the next morning." },
        { q: "Will you handle the insurance claim paperwork?", a: "We document the damage with photographs, provide the itemized scope your adjuster expects, and meet the adjuster on site if you want us there. You remain the policyholder and the decision-maker; we make the file complete." },
      ],
      image: null,
    },
    {
      slug: "roof-repair",
      name: "Roof Repair",
      primaryKeyword: "roof repair Springfield MO",
      description:
        "Leak diagnosis and roof repair in Springfield, MO: flashing, pipe boots, storm damage and missing shingles, fixed by the crew that finds the problem.",
      question: "Can a leaking roof be repaired instead of replaced?",
      answer:
        "Usually, yes. Most leaks come from flashing, pipe boots, nail pops or a handful of wind-lifted shingles, not from the roof as a whole. We find the entry point, repair it and photograph the fix. We recommend replacement only when the shingles are failing across the roof, and we show you why.",
      body: [
        "We start where the water shows up inside and trace it to where it gets in, which is rarely directly above.",
        "Repairs are matched to the existing shingle where a match exists; where it does not, we say so before we start.",
      ],
      faqs: [
        { q: "How do you find where a roof is leaking?", a: "We start at the stain inside, then inspect the roof above and uphill of it: flashing, pipe boots, valleys, ridge and any penetration. Water travels along decking and rafters, so the entry point is often several feet from the ceiling stain. We photograph what we find and show you." },
        { q: "Can you match my existing shingles?", a: "If the shingle line is still manufactured, yes, and we bring a sample to confirm on the roof before installing. Discontinued lines get the closest current match, and we tell you in advance how visible the difference will be from the ground." },
        { q: "Do you repair storm damage?", a: "Yes. Wind-lifted shingles, hail bruising, and impact damage from limbs are the most common calls after a storm. We tarp first if the roof is open, document everything for your insurer, and schedule the permanent repair as soon as materials are in hand." },
      ],
      image: null,
    },
  ],
  cities: [
    {
      slug: "nixa",
      name: "Nixa",
      tier: 1,
      primaryKeyword: "roofing contractor Nixa MO",
      description: "Roofing contractor serving Nixa, MO — roof replacement and repair by local crews, with the same crew from estimate to final walk-through.",
      question: "Do you serve Nixa?",
      answer:
        "Yes. Nixa is inside our core service area, about fifteen minutes from our Springfield base, and our crews are there most weeks. We handle roof replacement, leak repair and storm damage for Nixa homeowners and builders, with the same crew from the estimate to the final walk-through.",
      body: ["Nixa's newer subdivisions and its older homes near downtown need different roofs, and we have done both."],
      faqs: [
        { q: "How soon can you get to a job in Nixa?", a: "For an active leak, usually the same or next day for a tarp and inspection. For a scheduled replacement, typically within two to three weeks depending on the season. Storm weeks run longer, and we tell you the real date rather than an optimistic one." },
        { q: "Do you pull permits in Nixa?", a: "Yes. The City of Nixa requires a permit for roof replacement, and we file it as part of every job. The permit fee is on the written scope so there is nothing added later, and we schedule the city inspection when the roof is complete." },
        { q: "Is there a trip charge for Nixa?", a: "No. Nixa is inside our standard service area, so estimates, repairs and replacements are priced the same as in Springfield. Towns further out may carry a travel line on the scope, and we state it up front if so." },
      ],
    },
  ],
  homeFaqs: [
    { q: "Do you offer free estimates?", a: "Yes. We walk the roof, photograph what we find, and send a written scope the same day or the next. There is no charge and no obligation, and the scope is written so that you can compare it line by line with any other bid you receive." },
    { q: "Are your crews employees or subcontractors?", a: "Our own crews perform the work. The people who give you the estimate and the people on the roof are from the same company, which is why the scope, the schedule and the finished roof match." },
    { q: "Which areas do you serve?", a: "Springfield, Nixa, Ozark and Republic, Missouri, plus the surrounding county. If you are outside that list, call — we take some jobs further out when the schedule allows and tell you honestly if travel changes the price." },
  ],
  about: {
    title: "About Example Roofing Co.",
    body: [
      "Example Roofing Co. is a family-run roofing contractor based in Springfield, Missouri.",
      "We self-perform every roof with our own crews, which is how the estimate, the schedule and the finished work stay consistent.",
    ],
  },
  placeholders: [
    { page: "/", type: "image", description: "Hero photograph: finished roof, this client's own work" },
    { page: "/about/", type: "image", description: "Crew or owner photograph" },
  ],
};
