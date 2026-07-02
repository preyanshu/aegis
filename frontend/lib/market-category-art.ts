function normalizeCategory(value: string | null | undefined) {
    return (value ?? "").trim().toLowerCase();
}

export function marketCategoryArt(category: string | null | undefined) {
    const normalized = normalizeCategory(category);

    if (normalized === "macro") {
        return "/image-removebg-preview%20(15).png";
    }

    if (normalized === "crypto") {
        return "/image-removebg-preview%20(16).png";
    }

    if (normalized === "eth-related") {
        return "/image-removebg-preview%20(17).png";
    }

    if (normalized === "fx") {
        return "/image-removebg-preview%20(18).png";
    }

    if (normalized === "commodities") {
        return "/image-removebg-preview%20(19).png";
    }

    return null;
}
