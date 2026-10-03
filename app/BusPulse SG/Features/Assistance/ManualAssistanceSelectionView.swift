import SwiftUI

struct ManualAssistanceSelectionView: View {
    let context: AssistanceContext
    let onSend: (AssistanceRequest) -> Void
    @Environment(AssistanceRequestService.self) private var requestService
    @State private var need: AccessibilityNeed
    @State private var rampPreference: RampPreference
    @State private var routeID: String
    @State private var stopID: String
    @State private var actions: Set<AssistanceAction>

    init(context: AssistanceContext, initialRequest: AssistanceRequest?, onSend: @escaping (AssistanceRequest) -> Void) {
        self.context = context
        self.onSend = onSend
        _need = State(initialValue: initialRequest?.need ?? .none)
        _rampPreference = State(initialValue: initialRequest?.rampPreference ?? .unspecified)
        _routeID = State(initialValue: context.busService)
        _stopID = State(initialValue: context.stopCode)
        _actions = State(initialValue: Set(initialRequest?.assistanceRequested ?? []).union(initialRequest?.rampPreference == .requested ? [.deployWheelchairRamp] : []))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                AssistanceJourneyHeader(context: bookingContext, compact: true)
                if context.busService == "DEMO_ROUTE" {
                    TextField("Route ID", text: $routeID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("assistance.manual.route")
                    TextField("Stop ID", text: $stopID)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("assistance.manual.stop")
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("What help do you need?").font(.title3.bold())
                    ForEach(AssistanceAction.passengerChoices, id: \.self) { action in
                        Button {
                            if !actions.insert(action).inserted { actions.remove(action) }
                            if action == .deployWheelchairRamp {
                                rampPreference = actions.contains(action) ? .requested : .declined
                            }
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: action.symbolName)
                                    .font(.title3).frame(width: 26)
                                    .foregroundStyle(Color.pulseTeal)
                                Text(action.shortTitle).font(.body.weight(.medium))
                                    .foregroundStyle(.primary)
                                Spacer()
                                Image(systemName: actions.contains(action) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(actions.contains(action) ? Color.pulseTeal : .secondary)
                            }
                            .padding(16)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(actions.contains(action) ? .isSelected : [])
                        .accessibilityIdentifier("assistance.action.\(action.rawValue)")
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("About you").font(.headline)
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        ForEach([AccessibilityNeed.wheelchair, .cane, .stroller, .hearingAccessibility], id: \.self) { option in
                            Button {
                                need = need == option ? .none : option
                            } label: {
                                Label(option == .hearingAccessibility ? "Hearing impaired" : option.title,
                                      systemImage: option.symbolName)
                                    .font(.subheadline.weight(.medium))
                                    .frame(maxWidth: .infinity, minHeight: 56)
                                    .padding(8)
                                    .foregroundStyle(need == option ? Color.white : Color.primary)
                                    .background(need == option ? Color.pulseTeal : Color(.secondarySystemGroupedBackground),
                                                in: RoundedRectangle(cornerRadius: 14))
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(need == option ? .isSelected : [])
                            .accessibilityIdentifier("assistance.manual.need.\(option.rawValue)")
                        }
                    }
                    Text("Optional. Helps us tailor your assistance.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .accessibilityIdentifier("assistance.manual")
        .safeAreaInset(edge: .bottom) {
            Button("Send Request", systemImage: "paperplane.fill") {
                var selected = actions
                if rampPreference == .requested { selected.insert(.deployWheelchairRamp) }
                else { selected.remove(.deployWheelchairRamp) }
                onSend(AssistanceRequest(context: bookingContext, intent: .boarding, need: need,
                    preferredInteraction: need.automaticInteraction,
                    assistanceRequested: AssistanceAction.allCases.filter(selected.contains),
                    rampPreference: rampPreference))
            }
            .buttonStyle(.borderedProminent).controlSize(.large).tint(Color.pulseNavy)
            .frame(maxWidth: .infinity)
            .disabled(requestService.isUpdating || !HubBookingEnvelope.isValidID(routeID) || !HubBookingEnvelope.isValidID(stopID))
            .accessibilityIdentifier("assistance.manual.send")
            .padding().frame(maxWidth: .infinity).background(.regularMaterial)
        }
        .background(Color(.systemGroupedBackground))
    }

    private var bookingContext: AssistanceContext {
        AssistanceContext(stopCode: stopID, stopName: context.stopName, roadName: context.roadName,
                          busService: routeID, arrivalSlot: context.arrivalSlot, estimatedArrival: context.estimatedArrival)
    }
}
