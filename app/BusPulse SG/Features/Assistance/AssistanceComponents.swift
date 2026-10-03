import SwiftUI

struct AssistanceJourneyHeader: View {
    let context: AssistanceContext
    var compact = false

    @Environment(PreferencesStore.self) private var preferences

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            Text(context.busService)
                .font(TransitTypography.serviceNumber(enabled: preferences.useLTAIdentityTypography))
                .foregroundStyle(Color.black.opacity(0.82))
                .lineLimit(1)
                .minimumScaleFactor(0.55)
                .frame(width: compact ? 54 : 62, height: compact ? 42 : 48)
                .background(Color.pulseServiceGreen, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(context.estimatedArrival == nil ? "Route \(context.busService)" : "Next Bus \(context.busService) · \(context.etaDescription())")
                    .font(compact ? .headline : .title3.bold())
                Text("\(context.stopName) · \(context.stopCode)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(compact ? 13 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Bus \(context.busService), \(context.etaDescription()), at stop \(context.stopCode), \(context.stopName)")
        .accessibilityIdentifier("assistance.journey")
    }
}

struct AssistanceRequestSummaryCard: View {
    let request: AssistanceRequest
    var showsJourney = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Assistance Request", systemImage: "person.crop.circle.badge.checkmark")
                .font(.headline)
                .foregroundStyle(Color.pulseNavy)

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 7) {
                if showsJourney {
                    summaryRow("Bus", request.busService)
                }
                summaryRow("Intent", request.intent.title)
                summaryRow("Need", request.need.title)
                summaryRow("Ramp", request.rampPreference.title)
            }

            Divider()
            Text("Assistance requested")
                .font(.subheadline.bold())
            ForEach(request.assistanceRequested, id: \.self) { action in
                Label(action.title, systemImage: action.symbolName)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistance.summary")
    }

    private func summaryRow(_ title: String, _ value: String) -> some View {
        GridRow {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
        }
    }
}

/// The hub journey's three rounds, labelled as on the dashboard: Request received → At the stop → On board.
struct AssistanceJourneyProgress: View {
    let stage: HubJourneyStage?
    let matched: Bool

    private static let titles = ["Request received", "At the stop", "On board"]

    /// Index of the current round, or -1 when no booking is active.
    private var reached: Int {
        switch stage {
        case .booked?: 0
        case .atStop?: 1
        case .onBoard?: 2
        case .idle?, nil: -1
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(Self.titles.indices, id: \.self) { index in
                if index > 0 {
                    Rectangle()
                        .fill(index <= reached ? Color.pulseTeal : Color.secondary.opacity(0.25))
                        .frame(height: 2)
                        .padding(.top, 9)
                        .accessibilityHidden(true)
                }
                VStack(spacing: 6) {
                    Image(systemName: symbol(for: index))
                        .font(.headline)
                        .foregroundStyle(colour(for: index))
                    Text(Self.titles[index])
                        .font(.caption2.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(index > reached ? .secondary : .primary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("assistance.journey.progress")
    }

    private var accessibilityText: String {
        guard reached >= 0 else { return "No active booking" }
        let waiting = stage == .atStop && !matched ? ", waiting for the safety operator" : ""
        return "Step \(reached + 1) of 3, \(Self.titles[reached])\(waiting)"
    }

    private func symbol(for index: Int) -> String {
        if index < reached || (index == reached && stage == .onBoard) { return "checkmark.circle.fill" }
        if index == reached { return stage == .atStop && !matched ? "exclamationmark.circle.fill" : "circle.dotted" }
        return "circle"
    }

    private func colour(for index: Int) -> Color {
        if index < reached || (index == reached && stage == .onBoard) { return .pulseGreen }
        if index == reached { return stage == .atStop && !matched ? .pulseAmber : .pulseTeal }
        return .secondary
    }
}

struct AssistanceStatusRail: View {
    let phase: AssistanceRequestPhase

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            railStep("Prepared", state: .complete)
            connector(complete: phase != .readyToSend && phase != .draft)
            railStep("Sent", state: sentState)
            connector(complete: phase == .received || phase == .active || phase == .completed)
            railStep("Bus confirmed", state: receivedState)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(phase.accessibilityLabel)
        .accessibilityIdentifier("assistance.status.rail")
    }

    private enum RailState {
        case pending
        case current
        case complete
        case failed
    }

    private var sentState: RailState {
        switch phase {
        case .sending: .current
        case .sent, .received, .active, .completed: .complete
        case .failed: .failed
        default: .pending
        }
    }

    private var receivedState: RailState {
        switch phase {
        case .sent: .current
        case .received, .active, .completed: .complete
        case .failed: .failed
        default: .pending
        }
    }

    private func railStep(_ title: String, state: RailState) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol(for: state))
                .font(.headline)
                .foregroundStyle(colour(for: state))
            Text(title)
                .font(.caption2.weight(.semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(state == .pending ? .secondary : .primary)
        }
        .frame(maxWidth: .infinity)
    }

    private func connector(complete: Bool) -> some View {
        Rectangle()
            .fill(complete ? Color.pulseTeal : Color.secondary.opacity(0.25))
            .frame(height: 2)
            .padding(.top, 9)
            .accessibilityHidden(true)
    }

    private func symbol(for state: RailState) -> String {
        switch state {
        case .pending: "circle"
        case .current: "circle.dotted"
        case .complete: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        }
    }

    private func colour(for state: RailState) -> Color {
        switch state {
        case .pending: .secondary
        case .current: .pulseTeal
        case .complete: .pulseGreen
        case .failed: .pulseRed
        }
    }
}

struct AssistanceMapControl: View {
    let context: AssistanceContext
    let session: AssistanceSession?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: statusSymbol)
                    .font(.subheadline.bold())
                    .foregroundStyle(statusColour)
                VStack(alignment: .leading, spacing: 1) {
                    Text(controlTitle)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.primary)
                    Text(controlDetail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 9)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the assistance request flow for this upcoming bus")
        .accessibilityIdentifier("assistance.mapControl.\(context.busService)")
    }

    private var controlTitle: String {
        guard let session else { return "Request Assistance" }
        if let hub = session.hubFeedback { return hub.isTerminal ? "Request Assistance" : "Assistance requested" }
        return switch session.phase {
        case .sending: "Sending assistance…"
        case .sent: "Waiting for bus…"
        case .received, .active: "Assistance requested"
        case .failed: "Assistance needs attention"
        default: "Request Assistance"
        }
    }

    private var controlDetail: String {
        guard let session else { return "Next bus · \(context.etaDescription())" }
        if let hub = session.hubFeedback { return hub.title }
        return switch session.phase {
        case .received, .active: "Received by Bus \(context.busService)"
        case .failed: "Open to retry"
        default: "Bus \(context.busService) · \(context.etaDescription())"
        }
    }

    private var statusSymbol: String {
        guard let session else { return "hand.raised.fill" }
        return switch session.phase {
        case .sending, .sent: "arrow.up.circle.fill"
        case .received, .active: "checkmark.seal.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "hand.raised.fill"
        }
    }

    private var statusColour: Color {
        guard let session else { return Color.pulseTeal }
        return switch session.phase {
        case .received, .active: Color.pulseGreen
        case .failed: Color.pulseRed
        default: Color.pulseTeal
        }
    }
}

/// Mirrors the map's green bus-stop sign and white code panel.
struct AssistanceStopSign: View {
    let context: AssistanceContext
    @ScaledMetric(relativeTo: .caption) private var codeSize = 14

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "bus.fill").foregroundStyle(Color.pulseNavy)
                Rectangle().fill(Color.pulseNavy).frame(width: 1.5, height: 18)
                Text(context.stopCode)
                    .font(.custom(TransitTypography.postScriptName, fixedSize: codeSize))
                    .lineLimit(1).minimumScaleFactor(0.7)
                    .foregroundStyle(.black.opacity(0.86))
                    .padding(.horizontal, 7).padding(.vertical, 4)
                    .background(.white, in: RoundedRectangle(cornerRadius: 4))
            }
            .padding(4).padding(.leading, 3)
            .background(Color.pulseServiceGreen, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white.opacity(0.94), lineWidth: 1))
            .fixedSize()
            Text(context.stopName)
                .font(TransitTypography.stopName(enabled: true))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Bus stop \(context.stopCode), \(context.stopName)")
    }
}
