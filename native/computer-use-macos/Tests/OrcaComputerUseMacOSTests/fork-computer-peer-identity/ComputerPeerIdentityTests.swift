import XCTest
@testable import OrcaComputerUseMacOSCore

final class ComputerPeerIdentityTests: XCTestCase {
    func testAcceptsPackagedFork() {
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.zpyoung.orca"))
    }

    func testPreservesUpstreamAndDevelopmentApplications() {
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.stablyai.orca"))
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.stablyai.orca.dev.worktree"))
        XCTAssertTrue(isTrustedComputerPeerBundleIdentifier("com.github.Electron"))
    }

    func testRejectsUnrelatedAndLookalikeApplications() {
        for bundleId in ["", "com.example.app", "com.zpyoung.orca.evil", "com.zpyoung.orca-helper", "com.stablyai.orca.evil", "com.github.Electron.evil"] {
            XCTAssertFalse(isTrustedComputerPeerBundleIdentifier(bundleId), bundleId)
        }
    }
}
