import CoreText
import SwiftUI
import UIKit

extension Color {
    static let pulseNavy = Color(red: 0.043, green: 0.122, blue: 0.200)
    static let pulseTeal = Color(red: 0.039, green: 0.624, blue: 0.647)
    static let pulseAmber = Color(red: 0.984, green: 0.627, blue: 0.184)
    static let pulseRed = Color(red: 0.859, green: 0.243, blue: 0.231)
    static let pulseGreen = Color(red: 0.176, green: 0.620, blue: 0.400)
    static let pulseServiceGreen = Color(red: 147.0 / 255.0, green: 213.0 / 255.0, blue: 0)
    static let pulseDataInk = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 0.235, green: 0.820, blue: 0.835, alpha: 1)
        }
        return UIColor(red: 0.043, green: 0.122, blue: 0.200, alpha: 1)
    })
}

enum TransitTypography {
    static let postScriptName = "LTAIdentity"
    static let bundledFontFilename = "LTAIdentity.Medium"

    @discardableResult
    static func registerBundledFont(in bundle: Bundle = .main) -> Bool {
        if isLTAIdentityAvailable { return true }

        let fontURL = bundle.url(forResource: bundledFontFilename, withExtension: "ttf")
            ?? bundle.url(
                forResource: bundledFontFilename,
                withExtension: "ttf",
                subdirectory: "Resources/Fonts"
            )
            ?? bundle.url(
                forResource: bundledFontFilename,
                withExtension: "ttf",
                subdirectory: "Fonts"
            )
        guard let fontURL else { return false }

        var registrationError: Unmanaged<CFError>?
        let registered = CTFontManagerRegisterFontsForURL(
            fontURL as CFURL,
            .process,
            &registrationError
        )
        return registered || isLTAIdentityAvailable
    }

    static var isLTAIdentityAvailable: Bool {
        UIFont(name: postScriptName, size: 17) != nil
    }

    static func stopName(enabled: Bool) -> Font {
        ltaFont(size: 18, relativeTo: .headline, enabled: enabled)
            ?? .headline.weight(.bold)
    }

    static func stopMetadata(enabled: Bool) -> Font {
        ltaFont(size: 15, relativeTo: .subheadline, enabled: enabled)
            ?? .subheadline.weight(.semibold)
    }

    static func serviceNumber(enabled: Bool) -> Font {
        ltaFont(size: 22, relativeTo: .title3, enabled: enabled)
            ?? .system(.title3, design: .rounded, weight: .heavy)
    }

    private static func ltaFont(
        size: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        enabled: Bool
    ) -> Font? {
        guard enabled, isLTAIdentityAvailable else { return nil }
        return .custom(postScriptName, size: size, relativeTo: textStyle)
    }
}
