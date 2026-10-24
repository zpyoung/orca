public func isTrustedComputerPeerBundleIdentifier(_ bundleId: String) -> Bool {
    return bundleId == "com.zpyoung.orca" ||
        bundleId == "com.stablyai.orca" ||
        bundleId == "com.stablyai.orca.dev" ||
        bundleId.hasPrefix("com.stablyai.orca.dev.") ||
        bundleId == "com.github.Electron"
}
