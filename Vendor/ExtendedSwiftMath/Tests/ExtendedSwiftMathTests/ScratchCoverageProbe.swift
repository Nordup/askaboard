// Temporary coverage probe. Deleted after use — not part of the suite.
// 1. Parses every formula the tutor has emitted (harvested from the recorder DB).
// 2. Probes every command name extracted from KaTeX's supported-functions page.

import XCTest
@testable import ExtendedSwiftMath

final class ScratchCoverageProbe: XCTestCase {

    let scratch = "/private/tmp/claude-501/-Users-nordup-Projects-other-math-tutor/782fb5c2-3978-4eff-919e-37eaf8c51b67/scratchpad"

    private func parses(_ latex: String) -> String? {
        var error: NSError? = nil
        _ = MTMathListBuilder.build(fromString: latex, error: &error)
        return error?.localizedDescription
    }

    func testHarvestedFormulas() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: scratch + "/formulas.json"))
        let entries = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        var failures: [[String: Any]] = []
        for entry in entries {
            let latex = entry["latex"] as! String
            if let err = parses(latex) {
                failures.append(["latex": latex, "count": entry["count"]!, "error": err])
            }
        }
        let out = try JSONSerialization.data(withJSONObject: failures, options: [.prettyPrinted])
        try out.write(to: URL(fileURLWithPath: scratch + "/formula-failures.json"))
        print("HARVEST: \(entries.count) formulas, \(failures.count) fail")
    }

    func testKatexCommandProbe() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: scratch + "/katex-commands.json"))
        let commands = try JSONSerialization.jsonObject(with: data) as! [String]
        var unsupported: [[String: String]] = []
        for cmd in commands {
            // Probe with 0..3 braced arguments; supported if any form parses.
            let variants = [cmd, "\(cmd){x}", "\(cmd){x}{y}", "\(cmd){x}{y}{z}"]
            var lastError = ""
            var ok = false
            for v in variants {
                if let err = parses(v) {
                    lastError = err
                } else {
                    ok = true
                    break
                }
            }
            if !ok {
                unsupported.append(["command": cmd, "error": lastError])
            }
        }
        let out = try JSONSerialization.data(withJSONObject: unsupported, options: [.prettyPrinted, .sortedKeys])
        try out.write(to: URL(fileURLWithPath: scratch + "/katex-unsupported.json"))
        print("KATEX: \(commands.count) probed, \(unsupported.count) unsupported")
    }
}
