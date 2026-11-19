/**
 * Every user-visible string in the application.
 *
 * Components must not contain literal copy. A future `ar.ts` only has to satisfy the
 * `AppStrings` type exported below, so translation never requires touching a component.
 */
export const en = {
  app: {
    name: 'Gym Tracker',
    titleSeparator: ' · ',
    tagline: 'A private workout journal that stays on this device.',
  },
  a11y: {
    skipToContent: 'Skip to main content',
    primaryNavigation: 'Primary',
    openSettings: 'Settings',
  },
  nav: {
    today: 'Today',
    workout: 'Workout',
    machines: 'Machines',
    history: 'History',
    progress: 'Progress',
    settings: 'Settings',
  },
  pages: {
    today: {
      title: 'Today',
      heading: 'Today',
      lead: 'Start here when you arrive at the gym.',
      startWorkout: 'Start workout',
      startWorkoutHint: 'Choose your usual session, a blank one, or a copy of a recent workout.',
      resumeWorkout: 'Resume workout',
      resumeHint: 'A workout is already in progress. Pick up where you left off.',
      activeTitle: 'Workout in progress',
      activeBody: '{name} started at {time}.',
      loading: 'Checking for a workout in progress',
      emptyTitle: 'No workouts recorded yet',
      emptyBody:
        'Nothing has been logged on this device. Once you finish a session, it will be listed here.',
      errorTitle: 'Today could not be loaded',
    },
    workout: {
      title: 'Workout',
      heading: 'Workout',
      lead: 'The active session lives here.',
      loading: 'Loading your workout',
      errorTitle: 'This workout could not be loaded',

      /* Starting -------------------------------------------------------- */
      startHeading: 'Start a workout',
      startLead: 'Pick a starting point. You can change anything once the session is running.',
      startFromTemplate: 'Start {name}',
      templateSummary: '{count} activities',
      startBlank: 'Start a blank workout',
      startBlankHint: 'An empty session. Add what you actually do.',
      blankSessionName: 'Workout',
      recentHeading: 'Repeat a recent session',
      recentHint: 'Copies the plan only. None of the recorded numbers come with it.',
      copyRecent: 'Copy {name} from {date}',
      noRecentTitle: 'No completed sessions to copy yet',
      noRecentBody:
        'Once you finish a workout, it will be offered here as a starting point for the next one.',
      noTemplatesTitle: 'No saved routines',
      noTemplatesBody: 'Start a blank workout and it can become a routine later.',
      conflictTitle: 'A workout is already in progress',
      conflictBody:
        'Only one workout can be open at a time, so nothing was started. Resume the one you have, or finish or cancel it first.',
      conflictResume: 'Go to the workout in progress',

      /* Active shell ---------------------------------------------------- */
      elapsedLabel: 'Elapsed time',
      startedAtLabel: 'Started',
      activitiesHeading: 'Activities',
      noActivitiesTitle: 'Nothing in this session yet',
      noActivitiesBody:
        'This is a blank workout. Add the treadmill below and its first segment is ready to record.',
      noSegmentsTitle: 'No segments yet',
      noSegmentsBody: 'Add a segment to record what the treadmill showed.',
      addCardioActivity: 'Add treadmill activity',
      cardioActivityName: 'Treadmill',
      strengthLoadBasisLabel: 'A number here means',
      strengthSetupLabel: 'Setup',
      strengthUnknownBasisNote:
        'What this number means has not been recorded for this machine, so choose it on each set. A set whose meaning stays unknown is still saved, but it is never compared with another.',
      strengthContextErrorTitle: 'The details for this machine could not be read',
      strengthContextErrorBody:
        'You can still log sets here and they will be saved. Until this is read, no set is compared with an earlier one, and the step size and rest fall back to your preferences.',
      settingsUnavailableTitle: 'Your preferences could not be read',
      settingsUnavailableBody:
        'Nothing was lost. Step sizes and rest lengths come from your preferences, so machines wait for them rather than using numbers you never chose.',
      settingsMissingTitle: 'Your preferences are missing from this device',
      settingsMissingBody:
        'The stored preferences record was not found, so nothing can decide the step size or rest length. Open Settings, or reload the app, to have it created again.',
      strengthWaitingOnSettingsTitle: 'Sets cannot be logged here yet',
      strengthWaitingOnSettingsBody:
        'This machine is waiting on your preferences, which decide the step size and the rest length. The message above says how to try again.',

      /* Strength sets ---------------------------------------------------- */
      strengthNoSetsTitle: 'No sets recorded here yet',
      strengthNoSetsBody: 'Add a set once you have done one. Nothing is filled in for you.',
      addSet: 'Add set',
      copyLastSet: 'Copy last set',
      copyLastSetHint:
        'Fills a new set with the same reps and weight, ready for you to change. Nothing is recorded until you save it or mark it done.',
      setProposedNote:
        'These numbers came from the set above, ready for you to change. Nothing here is recorded yet, so this set can still be removed or skipped.',
      setHeading: 'Set {position}',
      setActionsLabel: 'Actions for set {position}',
      draftSetLabel: '{machine}, set {position}',
      setTypeLabel: 'Set type',
      sideLabel: 'Side',
      repsLabel: 'Reps',
      setDurationLabel: 'Time',
      setDurationHint: 'Minutes and seconds, like 00:45. Leave blank if you counted reps.',
      loadLabel: 'Weight',
      loadUnitLabel: 'Weight unit',
      loadBasisLabel: 'What this number means',
      setRpeLabel: 'How hard it felt (1-10)',
      setRirLabel: 'Reps left in reserve',
      setNotesLabel: 'Notes',
      moreSetDetail: 'Effort, reps in reserve, and notes',
      increaseLoad: 'Increase weight by {value} {unit}',
      decreaseLoad: 'Decrease weight by {value} {unit}',
      bodyweightNoLoadTitle: 'No weight is recorded for a bodyweight set',
      bodyweightNoLoadBody:
        'Your own weight is not stored here. Choose another meaning if you added or removed weight.',
      saveSet: 'Save',
      completeSet: 'Mark done',
      reopenSet: 'Reopen',
      skipSet: 'Skip',
      unskipSet: 'Un-skip',
      removeSet: 'Remove',
      completeSetNeedsWorkError: 'Record reps or a time above zero before marking this done.',
      removeSetBlockedTitle: 'This set was not removed',
      skipSetBlockedTitle: 'This set was not skipped',
      setRecordedWorkBlockedBody:
        'It holds something you recorded - reps, a time, a weight, an effort rating, or a note. Reopen it and clear what is there if you really want this.',
      setUnsavedBlockedBody:
        'Your latest change has not been saved yet, so nothing was changed here. Save it first - then this set can be removed or skipped only if it really holds nothing.',
      removeSetDialogTitle: 'Remove this set?',
      removeSetDialogBody: 'It has nothing recorded on it, so nothing will be lost.',
      removeSetDialogConfirm: 'Yes, remove it',
      removeSetDialogCancel: 'Keep it',

      /* Previous comparable result and records --------------------------- */
      previousHeading: 'Last time on this exact setup',
      previousNone:
        'Nothing comparable yet. A result is only compared on the same machine, exercise, saved setup, meaning, and side.',
      previousNotComparable:
        'This set is not compared with anything, because what its number means has not been recorded.',
      previousLoad: '{load} ({basis})',
      previousReps: '{count} reps',
      previousDuration: 'held {value}',
      previousFrom: 'From {name} on {date}.',
      recordHeading: 'Personal best',
      recordLoadHigher: 'Heaviest yet on this setup',
      recordLoadLower: 'Least assistance yet on this setup',
      recordRepsAtLoad: 'Most reps yet at this weight',
      recordExplanationOne:
        'Compared with 1 earlier finished set on the same machine, exercise, saved setup, meaning, and side. Previous best: {previous}.',
      recordExplanationOther:
        'Compared with {count} earlier finished sets on the same machine, exercise, saved setup, meaning, and side. Previous best: {previous}.',
      firstComparableResult:
        'First finished set on this setup, so there is nothing to compare it with yet.',
      previousUnavailable:
        'Your earlier sets could not be read just now, so nothing is compared here. This set is still saved normally.',
      recordsUnavailable:
        'Your earlier sets could not be read, so this set was not compared with any of them. That is not the same as there being none.',

      /* Rest timer ------------------------------------------------------- */
      restHeading: 'Rest',
      restRemaining: '{value} left',
      restOver: 'Rest time is up',
      restDismiss: 'Hide rest timer',
      restNote: 'Nothing waits for this. Keep logging whenever you are ready.',

      /* Adding a strength activity --------------------------------------- */
      addStrengthActivity: 'Add a machine',
      pickerHeading: 'Add a machine to this workout',
      pickerMachineStep: 'Choose the machine',
      pickerExerciseStep: 'Choose the exercise on {name}',
      pickerConfigStep: 'Choose the saved setup',
      pickerChooseMachine: 'Choose {name}',
      pickerChooseExercise: 'Choose {name}',
      pickerNoConfig: 'No saved setup',
      pickerNoConfigHint: 'Use the machine as it is. Nothing about the setup is recorded.',
      pickerBack: 'Back',
      pickerCancel: 'Cancel',
      pickerConfirm: 'Add to workout',
      pickerReview: 'What will be recorded',
      pickerAlsoCalled: 'Also called {names}',
      pickerNoMachinesTitle: 'No machines in your catalog',
      pickerNoMachinesBody: 'Add one in Machines, then it can be added to a workout.',
      pickerNoExercisesTitle: 'No exercises recorded for this machine',
      pickerNoExercisesBody:
        'A machine needs at least one exercise before a set can be logged on it. Add one in Machines, then come back.',
      pickerOpenMachines: 'Go to Machines',
      pickerErrorTitle: 'That machine was not added',
      pickerErrorBody:
        'Nothing was changed. The machine, exercise, or saved setup may have been archived or edited on another screen.',
      pickerIncrementLabel: 'Step size',
      pickerRestLabel: 'Rest between sets',
      pickerSeconds: '{value} seconds',
      pickerDefaults: 'Your current logging defaults',
      pickerDefaultsNote:
        'These are not recorded on this workout. They come from the machine, the saved setup, and your preferences every time you log a set, so changing any of those changes them here too.',
      pickerCatalogErrorTitle: 'Your machines could not be read',
      pickerMachineErrorTitle: 'That machine could not be read',
      pickerReadErrorBody:
        'Nothing was changed and nothing is missing from your catalog. This usually means the database is busy.',

      /* Strength summary ------------------------------------------------- */
      strengthSummaryHeading: 'Strength, machine by machine',
      strengthCompletedSetsOne: '1 set marked done',
      strengthCompletedSetsOther: '{count} sets marked done',
      strengthNoCompletedSets: 'No set was marked done here.',
      strengthVolumeLabel: 'Total weight moved',
      strengthVolumeNote:
        'Reps multiplied by the weight exactly as you recorded it, counted as {basis}, {side}.',
      volumeUnavailable: {
        no_completed_sets: 'Not shown: no set here was marked done.',
        basis_not_summable:
          'Not shown: these numbers do not add up to a weight moved. Each set is listed above.',
        mixed_basis:
          'Not shown: these sets do not all mean the same thing by their number, so adding them would invent a total.',
        mixed_side:
          'Not shown: left, right, and both cannot be added together. Each set is listed above.',
        incomplete_data: 'Not shown: at least one finished set here recorded no weight or no reps.',
      },
      strengthSavedNotFinishedHeading: 'Saved sets that were never marked done',
      strengthSavedNotFinishedNote:
        'These values are stored exactly as you entered them. They are kept out of the totals because the set was never marked done.',
      setSummaryHeading: 'Set {position} - {status}',
      summaryReps: 'Reps',
      summarySetDuration: 'Time',
      summaryLoad: 'Weight',
      summaryLoadBasis: 'What it means',
      summarySide: 'Side',
      summarySetType: 'Set type',
      summaryRir: 'Reps in reserve',

      /* Save state ------------------------------------------------------ */
      saveStateSaved: 'Saved',
      saveStateSaving: 'Saving',
      saveStateProposed: 'Nothing recorded yet',
      saveStateUnsaved: 'Not saved yet',
      saveStateFailed: 'Not saved',
      saveFailedBody:
        'Nothing on this device was changed and what you typed is still here. This usually means storage is full or the database is busy.',
      retry: 'Try again',

      /* Segments -------------------------------------------------------- */
      segmentHeading: 'Segment {position}: {mode}',
      targetHeading: 'Target',
      actualHeading: 'What the treadmill showed',
      noTarget: 'No target set for this segment.',
      targetDistance: 'Distance',
      targetDuration: 'Target time',
      targetDurationDerived: 'about {value}',
      targetDurationDerivedHint: 'Worked out from the target distance and speed, not measured.',
      targetSpeed: 'Speed',
      targetIncline: 'Incline',
      inclineUnconfirmed: '{value} — unit not confirmed',
      inclineWithType: '{value} ({type})',
      actualDistanceLabel: 'Distance (km)',
      actualDurationLabel: 'Time',
      actualDurationHint: 'Minutes and seconds, like 16:00.',
      actualSpeedLabel: 'Speed shown (km/h)',
      actualInclineLabel: 'Incline shown',
      actualInclineTypeLabel: 'Incline is measured in',
      moreDetail: 'Heart rate, effort, and notes',
      averageHeartRateLabel: 'Average heart rate (bpm)',
      maxHeartRateLabel: 'Maximum heart rate (bpm)',
      rpeLabel: 'How hard it felt (1-10)',
      segmentNotesLabel: 'Notes',
      modeLabel: 'Segment type',
      saveSegment: 'Save',
      completeSegment: 'Mark done',
      reopenSegment: 'Reopen',
      unskipSegment: 'Un-skip',
      skipSegment: 'Skip',
      removeSegment: 'Remove',
      moveUp: 'Move up',
      moveDown: 'Move down',
      addSegment: 'Add segment',
      segmentActionsLabel: 'Actions for segment {position}',
      derivedSpeedLabel: 'Works out at',
      derivedAverageSpeed: 'Works out at {value} km/h',
      derivedAverageSpeedHint:
        'Calculated from the distance and time you recorded. It does not replace the speed the treadmill displayed.',
      completeNeedsWorkError: 'Record a distance or a time above zero before marking this done.',
      removeBlockedTitle: 'This segment was not removed',
      skipBlockedTitle: 'This segment was not skipped',
      unsavedBlockedBody:
        'Your latest change has not been saved yet, so nothing was changed here. Save it first - then this segment can be removed or skipped only if it really holds nothing.',
      recordedWorkBlockedBody:
        'It holds something you recorded - a number, a heart rate, an effort rating, or a note. Reopen it and clear what is there if you really want this.',
      draftBlockedTitle: 'The workout is still open',
      draftBlockedInvalidBody:
        '{segment} holds a value that cannot be saved, so nothing was closed. Correct it or clear it, then try again.',
      draftBlockedFailedBody:
        '{segment} has changes that are not saved yet, so nothing was closed and nothing you typed was lost. Save it, then try again.',

      /* Removal, finish, cancel ----------------------------------------- */
      removeDialogTitle: 'Remove this segment?',
      removeDialogBody: 'It has nothing recorded on it, so nothing will be lost.',
      removeDialogConfirm: 'Yes, remove it',
      removeDialogCancel: 'Keep it',
      finish: 'Finish workout',
      finishDialogTitle: 'Finish this workout?',
      finishDialogBody:
        'The session is closed and moved into your history. Anything you recorded is kept exactly as it is.',
      finishDialogConfirm: 'Yes, finish it',
      finishDialogCancel: 'Keep going',
      finishErrorTitle: 'This workout was not finished',
      cancel: 'Cancel workout',
      cancelDialogTitle: 'Cancel this workout?',
      cancelDialogBody:
        'The session is closed without being counted as finished. Everything you already recorded is kept, not deleted.',
      cancelDialogConfirm: 'Yes, cancel it',
      cancelDialogCancel: 'Keep going',
      cancelErrorTitle: 'This workout was not cancelled',
      close: 'Close',

      /* Summary --------------------------------------------------------- */
      summaryHeading: 'Session summary',
      finishedTitle: 'Workout finished',
      finishedBody: 'It is saved on this device.',
      cancelledTitle: 'Workout cancelled',
      cancelledBody: 'What you recorded was kept.',
      backToToday: 'Back to Today',
      summaryStarted: 'Started',
      summaryEnded: 'Ended',
      summaryElapsed: 'Total time',
      summaryActivities: 'Activities in order',
      /*
       * These four totals count treadmill segments and nothing else, so they say so. An
       * unqualified "Recorded totals" over a number that ignores every strength set was
       * read as a statement about the workout, which is how a finished 10 x 60 kg set
       * ended up under the words "Nothing was recorded".
       */
      plannedTotalsHeading: 'Cardio target totals',
      actualTotalsHeading: 'Cardio recorded totals',
      totalDistance: 'Distance',
      totalDuration: 'Time',
      averageSpeed: 'Average speed',
      noActualTitle: 'No cardio was recorded',
      noneMarkedDoneTitle: 'No cardio segment was marked done',
      noneMarkedDoneBody:
        'There are no recorded cardio totals, because a total counts finished segments. What you did save is listed below.',
      /** The only unqualified claim, and it is made only when both halves are empty. */
      noWorkRecordedTitle: 'Nothing was recorded in this workout',
      noWorkRecordedBody:
        'No segment and no set was marked done, and nothing was saved on one either. Anything you had typed is still on this device while this workout stays open.',
      savedNotFinishedHeading: 'Saved, but never marked done',
      savedNotFinishedNote:
        'These values are stored exactly as you entered them. They are kept out of the recorded totals because the segment was never marked done.',
      noActualBody:
        'No treadmill segment was marked done, so there are no recorded cardio totals. The targets above are still shown on their own.',
      segmentComparisonHeading: 'Target and recorded, segment by segment',
      summaryRecordedColumn: 'Recorded',
      summaryAverageHeartRate: 'Average heart rate',
      summaryMaxHeartRate: 'Maximum heart rate',
      summaryEffort: 'How hard it felt',
      summaryNote: 'Note',
      notRecorded: 'Not recorded',
      kilometres: '{value} km',
      kilometresPerHour: '{value} km/h',
      loadWithUnit: '{value} {unit}',
      beatsPerMinute: '{value} bpm',
      effortOutOfTen: '{value} out of 10',
    },
    machines: {
      title: 'Machines',
      heading: 'Machines',
      lead: 'Pick equipment by its photo, then choose the exercise performed on it.',
      emptyTitle: 'No machines in the catalog yet',
      emptyBody: 'Add a machine to start building your catalog.',
      loading: 'Loading your machines',
      searchLabel: 'Search machines',
      searchPlaceholder: 'Name or another name you use',
      clearSearch: 'Clear search',
      filtersHeading: 'Filters',
      filtersActive: 'Filters ({count} on)',
      muscleFilterLabel: 'Muscle group',
      loadingKindFilterLabel: 'How it is loaded',
      anyOption: 'Any',
      favoritesOnly: 'Favourites only',
      viewLabel: 'Show',
      viewActive: 'Active',
      viewArchived: 'Archived',
      clearFilters: 'Clear all filters',
      resultCountOne: '1 machine',
      resultCountOther: '{count} machines',
      noResultsTitle: 'No machines match these filters',
      noResultsBody: 'Try a different search, or clear the filters to see the whole catalog.',
      noArchivedTitle: 'Nothing is archived',
      noArchivedBody: 'Machines you archive are kept here so past workouts stay readable.',
      addMachine: 'Add machine',
      favoriteAdd: 'Add {name} to favourites',
      favoriteRemove: 'Remove {name} from favourites',
      archivedBadge: 'Archived',
      openMachine: 'Open {name}',
      photoMissing: 'No photo',
      photoFailed: 'Photo could not be displayed',
    },
    machineDetail: {
      title: 'Machine',
      backToCatalog: 'Back to machines',
      notFoundTitle: 'That machine is not in your catalog',
      notFoundBody: 'It may have been removed on another device, or the address may be wrong.',
      alsoCalled: 'Also called',
      identification: 'Identification',
      confidenceLabel: 'How certain this is',
      loadingKindLabel: 'How it is loaded',
      categoryLabel: 'Area',
      primaryMuscles: 'Mainly works',
      secondaryMuscles: 'Also works',
      musclesUnrecorded: 'Not recorded - it depends on the exercise you do here.',
      defaultsHeading: 'What a number here means',
      loadBasisLabel: 'Load basis',
      loadBasisUnset: 'Not set - you choose when you log a set.',
      loadUnitLabel: 'Unit',
      incrementLabel: 'Step',
      restLabel: 'Default rest',
      defaultsFromSettings: 'From your settings',
      defaultsFromMachine: 'Set on this machine',
      exercisesHeading: 'Exercises on this machine',
      noExercisesTitle: 'No exercises recorded here yet',
      noExercisesBody:
        'This machine supports many movements. Add the ones you actually perform so they are ready when you log a workout.',
      addExercise: 'Add exercise',
      attachmentLabel: 'Attachment',
      pulleyLabel: 'Pulley position',
      seatLabel: 'Seat position',
      footLabel: 'Foot position',
      gripLabel: 'Grip',
      setupNoteLabel: 'Setup',
      edit: 'Edit machine',
      archive: 'Archive',
      restore: 'Restore',
      archivedNotice:
        'This machine is archived. It stays out of the catalog but past workouts still show it.',
      seededNote: 'Added from your photos. You can correct anything here.',
    },
    machineForm: {
      newTitle: 'Add machine',
      newHeading: 'Add a machine',
      editTitle: 'Edit machine',
      editHeading: 'Edit machine',
      newLead: 'Describe the equipment. You can change any of this later.',
      editLead: 'Correct anything that is wrong. Past workouts keep the details they recorded.',
      nameLabel: 'Name',
      nameHint: 'What you call it.',
      aliasesLabel: 'Other names',
      aliasesHint: 'Separate names with a comma. Search looks at these too.',
      categoryLabel: 'Area of the body',
      loadingKindLabel: 'How it is loaded',
      primaryMusclesLabel: 'Mainly works',
      secondaryMusclesLabel: 'Also works',
      confidenceLabel: 'How certain the identification is',
      confirmationNoteLabel: 'What is known and unknown',
      confirmationNoteHint:
        'Record anything still unconfirmed, such as the brand or the stack unit.',
      defaultsHeading: 'Defaults for logging',
      defaultLoadUnitLabel: 'Unit',
      defaultLoadBasisLabel: 'What the number means',
      useGlobalOption: 'Use my settings',
      unsetBasisOption: 'Ask me each time',
      incrementValueLabel: 'Step size',
      incrementUnitLabel: 'Step unit',
      incrementHint: 'Leave both blank to use your settings.',
      photoHeading: 'Photo',
      photoLabel: 'Choose a photo',
      photoHint: 'Stays on this device. It is resized here before it is saved.',
      photoSelected: 'Photo ready to save',
      photoRemove: 'Remove photo',
      photoReplace: 'Replace photo',
      photoProcessing: 'Preparing photo',
      save: 'Save machine',
      saveChanges: 'Save changes',
      cancel: 'Cancel',
      savingTitle: 'Saving',
      errorTitle: 'This machine was not saved',
      requiredField: 'Enter a name.',
      incrementPairError: 'Enter both a step size and its unit, or leave both blank.',
      incrementPositiveError: 'The step size must be greater than zero.',
      cancelNotice: 'Nothing was saved.',
    },
    exerciseForm: {
      heading: 'Add an exercise',
      lead: 'Record a movement you perform on this machine.',
      nameLabel: 'Exercise name',
      movementLabel: 'Movement',
      primaryMusclesLabel: 'Mainly works',
      secondaryMusclesLabel: 'Also works',
      attachmentLabel: 'Attachment',
      pulleyLabel: 'Pulley position',
      seatLabel: 'Seat position',
      footLabel: 'Foot position',
      gripLabel: 'Grip',
      setupNoteLabel: 'Setup note',
      loadBasisLabel: 'What the number means here',
      restLabel: 'Default rest (seconds)',
      save: 'Add exercise',
      cancel: 'Cancel',
      errorTitle: 'This exercise was not added',
      requiredField: 'Enter an exercise name.',
      archive: 'Archive exercise',
    },
    photoError: {
      title: 'That photo could not be used',
      input_too_large: 'The file is larger than this app will accept. Try a smaller photo.',
      unsupported_type: 'That file type is not supported. Use a JPEG, PNG, WebP, or AVIF photo.',
      decode_failed: 'The file could not be read as an image, whatever its name says.',
      dimensions_too_large: 'The image has too many pixels to process safely.',
      encode_failed: 'The photo could not be prepared on this device.',
      output_too_large: 'The prepared photo is still too large to store.',
    },
    archiveDialog: {
      title: 'Archive this machine?',
      body: 'It is removed from the catalog but kept, so past workouts still show what you used. You can restore it at any time.',
      confirm: 'Archive machine',
      cancel: 'Keep it',
      close: 'Close',
    },
    history: {
      title: 'History',
      heading: 'History',
      lead: 'Every recorded session, with the numbers exactly as they were recorded.',
      loading: 'Loading your history',
      errorTitle: 'History could not be loaded',
      errorBody:
        'Your workouts are still stored on this device. Nothing has been changed or removed.',
      retry: 'Try again',
      emptyTitle: 'No workouts recorded yet',
      emptyBody: 'Finished and cancelled sessions are listed here once you record one.',
      noResultsTitle: 'No workouts match these filters',
      noResultsBody: 'Your history is still here. Widen or clear the filters to see it again.',

      /* Filtering ------------------------------------------------------- */
      searchLabel: 'Search workouts',
      searchPlaceholder: 'Session, machine, or exercise name',
      clearSearch: 'Clear',
      filtersHeading: 'Filters',
      filtersActive: '{count} filters applied',
      statusLabel: 'Status',
      statusAll: 'Finished and cancelled',
      machineLabel: 'Machine',
      exerciseLabel: 'Exercise',
      anyMachine: 'Any machine',
      anyExercise: 'Any exercise',
      fromLabel: 'From date',
      toLabel: 'To date',
      dateHint: 'Dates use the day each workout started on, in its own time zone.',
      clearFilters: 'Clear filters',
      showAll: 'Show all workouts',
      viewLabel: 'Arrange',
      viewList: 'One list',
      viewByDay: 'By day',
      resultCount: '{count} workouts',
      resultCountOne: '1 workout',

      /* Deleted -------------------------------------------------------- */
      openTrash: 'Recently deleted',
      trashHeading: 'Recently deleted',
      trashLead:
        'These workouts are hidden from history, comparisons, and progress. Nothing inside them has been removed.',
      trashEmptyTitle: 'Nothing has been deleted',
      trashEmptyBody: 'Deleted workouts wait here until you restore them.',
      backToHistory: 'Back to history',
      deletedAt: 'Deleted {time}',
      restore: 'Restore',
      restoring: 'Restoring',
      restored: 'Workout restored',
      restoreFailed: 'This workout could not be restored',

      /* One row --------------------------------------------------------- */
      openSession: 'Open {name}',
      startedAt: 'Started {time}',
      duration: 'Lasted {duration}',
      durationUnknown: 'Length not recorded',
      activityCount: '{count} activities',
      activityCountOne: '1 activity',
      completedSets: '{count} sets done',
      completedSetsOne: '1 set done',
      completedSegments: '{count} segments done',
      completedSegmentsOne: '1 segment done',
      savedNotCompleted: '{count} saved but never marked done',

      detail: {
        title: 'Workout',
        loading: 'Loading this workout',
        errorTitle: 'This workout could not be loaded',
        errorBody: 'Nothing has been changed. The record is still stored on this device.',
        retry: 'Try again',
        notFoundTitle: 'That workout is not here',
        notFoundBody: 'It may have been deleted, or the link may be from another device.',
        backToHistory: 'Back to history',
        inProgressTitle: 'This workout is still open',
        inProgressBody:
          'It has not been finished or cancelled yet, so there is nothing recorded to correct, delete, or repeat. Open it to carry on.',
        resumeWorkout: 'Resume this workout',
        deletedTitle: 'This workout is in Recently deleted',
        deletedBody:
          'It is hidden from history, comparisons, and progress. Restore it to correct it.',

        /* Session facts ------------------------------------------------- */
        statusLabel: 'Status',
        startedLabel: 'Started',
        endedLabel: 'Ended',
        cancelledLabel: 'Cancelled',
        durationLabel: 'Length',
        timeZoneLabel: 'Recorded in',
        notRecorded: 'Not recorded',
        rpeLabel: 'Session effort',
        moodLabel: 'Mood',
        discomfortLabel: 'Discomfort',
        notesLabel: 'Notes',
        timestampLimitation:
          'Start and end times cannot be corrected here. Correcting them would move a workout to a different day, so it is left out until it can be done safely.',

        /* Activities ---------------------------------------------------- */
        activitiesHeading: 'What you did',
        noActivities: 'No activities were recorded in this workout.',
        snapshotOnlyTitle: 'Saved workout snapshot — no longer linked to the current catalog',
        snapshotOnlyBody:
          'The names and setup recorded at the time are shown below. This activity is not compared with anything, because the machine and exercise it referred to could not be kept.',
        archivedLinkTitle: 'This equipment has been archived since',
        archivedLinkBody:
          'The workout still refers to the record you logged it against. Archiving only stops new work being started on it.',
        missingLinkTitle: 'The catalog record for this activity is no longer there',
        missingLinkBody:
          'What you recorded is shown exactly as it was saved. It is not reconnected to another record.',

        /* Cardio -------------------------------------------------------- */
        plannedHeading: 'Planned',
        recordedHeading: 'Recorded',
        segmentLabel: 'Segment {position}',
        distanceLabel: 'Distance',
        durationFieldLabel: 'Time',
        speedLabel: 'Speed shown',
        derivedSpeedLabel: 'Average speed (calculated)',
        inclineLabel: 'Incline',
        avgHeartRateLabel: 'Average heart rate',
        maxHeartRateLabel: 'Maximum heart rate',
        effortLabel: 'Effort',
        noteLabel: 'Note',
        cardioTotalsHeading: 'Recorded cardio totals',
        cardioTotalsEmpty: 'No cardio segment was marked done in this workout.',

        /* Strength ------------------------------------------------------ */
        setLabel: 'Set {position}',
        repsLabel: 'Reps',
        loadLabel: 'Weight',
        basisLabel: 'What the number means',
        sideLabel: 'Side',
        unitLabel: 'Unit',
        setupLabel: 'Setup recorded',
        inclineTypeLabel: 'Incline measured in',
        rirLabel: 'Reps in reserve',
        volumeLabel: 'Total weight moved',
        volumePerSide: 'Total weight moved, per side',
        savedNotCompletedHeading: 'Saved, but never marked done',
        savedNotCompletedBody:
          'These values are stored exactly as you left them. They are deliberately outside every total, because nobody said this work was finished.',
        skippedNote: 'Skipped. Everything recorded on it is kept.',

        /* Correction ---------------------------------------------------- */
        correct: 'Correct this workout',
        correcting: 'Correcting this workout',
        correctionLead:
          'Change what was recorded. Identity, order, planned targets, and the equipment saved with this workout are left exactly as they are.',
        saveCorrection: 'Save corrections',
        savingCorrection: 'Saving',
        correctionSaved: 'Corrections saved',
        discardCorrection: 'Discard changes',
        correctionFailedTitle: 'These corrections were not saved',
        correctionFailedBody:
          'Nothing was changed. Everything you typed is still here, so you can try again.',
        retryCorrection: 'Try again',
        nameLabel: 'Workout name',
        nameRequired: 'A workout needs a name.',
        noChanges: 'Nothing has been changed yet.',

        /* Delete, restore, repeat --------------------------------------- */
        deleteAction: 'Delete workout',
        deleteTitle: 'Delete this workout?',
        deleteBody:
          '{name} moves to Recently deleted. Everything inside it is kept and you can restore it.',
        deleteConfirm: 'Delete',
        deleteCancel: 'Keep it',
        deleting: 'Deleting',
        deletedTitleShort: 'Workout deleted',
        deletedBodyShort: 'It is in Recently deleted until you restore it.',
        undoDelete: 'Undo',
        deleteFailedTitle: 'This workout was not deleted',
        deleteFailedBody: 'It is still in your history exactly as it was.',
        restore: 'Restore workout',
        restoring: 'Restoring',
        restoreFailedTitle: 'This workout was not restored',
        restoreFailedBody: 'It is still in Recently deleted.',
        repeat: 'Repeat this workout',
        repeating: 'Starting',
        repeatBody:
          'Starts a new workout with the same activities and planned targets. Nothing you recorded is copied into it.',
        repeatBlockedTitle: 'A workout is already in progress',
        repeatBlockedBody: 'Finish or cancel it first, then repeat this one.',
        goToWorkout: 'Go to the workout in progress',
        repeatFailedTitle: 'This workout could not be repeated',
        repeatFailedBody: 'Nothing was started and nothing was changed.',
        onlyCompletedCanRepeat: 'Only a finished workout can be repeated.',
      },
    },
    progress: {
      title: 'Progress',
      heading: 'Progress',
      lead: 'Trends are only shown when the results being compared are genuinely comparable.',
      loading: 'Loading your progress',
      errorTitle: 'Progress could not be loaded',
      errorBody:
        'This is a reading problem, not a sign that there is nothing to show. Your workouts are still stored on this device.',
      retry: 'Try again',
      emptyTitle: 'Nothing has been logged yet',
      emptyBody:
        'Progress reads finished workouts. Cancelled and deleted workouts are deliberately left out.',
      noResultsTitle: 'No finished workouts match these filters',
      noResultsBody: 'Your history is unchanged. Widen or clear the filters.',
      sourceNote:
        'Everything here comes from finished, undeleted workouts. Planned targets and work that was never marked done are never counted as results.',

      /* Filters ---------------------------------------------------------- */
      filtersHeading: 'Filters',
      filtersActive: '{count} filters applied',
      fromLabel: 'From date',
      toLabel: 'To date',
      kindLabel: 'Show',
      kindAll: 'Cardio and strength',
      kindCardio: 'Cardio',
      kindStrength: 'Strength',
      exerciseLabel: 'Exercise',
      machineLabel: 'Machine',
      basisLabel: 'What the weight means',
      sideLabel: 'Side',
      anyExercise: 'Any exercise',
      anyMachine: 'Any machine',
      anyBasis: 'Any meaning',
      anySide: 'Any side',
      clearFilters: 'Clear filters',
      showAll: 'Show everything logged',

      /* Cardio ----------------------------------------------------------- */
      cardioHeading: 'Cardio',
      cardioEmpty: 'No finished cardio segment is in this range.',
      cardioBaselineOnly:
        'One recorded segment. That is a starting point, not a direction — a second one is needed before anything can be compared.',
      cardioTableCaption: 'Every recorded cardio segment, oldest first',
      columnDate: 'Date',
      columnWorkout: 'Workout',
      columnSegment: 'Segment',
      columnDistance: 'Distance',
      columnTime: 'Time',
      columnSpeedShown: 'Speed shown',
      columnSpeedDerived: 'Average speed (calculated)',
      columnIncline: 'Incline',
      totalDistance: 'Total distance',
      totalTime: 'Total time',
      overallAverageSpeed: 'Average speed across the range',
      overallAverageUnavailable:
        'Not shown: an average needs every counted segment to record both a distance and a time.',
      inclineHeading: 'Incline readings',
      inclineGroupHeading: '{type}',
      inclineNote:
        'Percent grades, machine levels, and unconfirmed readings are listed separately. They are different measurements and are never combined into one number.',
      inclineNoElevation: 'Incline is a machine setting. It is not turned into height climbed.',

      /* Strength --------------------------------------------------------- */
      strengthHeading: 'Strength',
      strengthEmpty: 'No finished set is in this range.',
      strengthGroupNote:
        'Results only stand together when the exercise, machine, setup, what the weight means, and the side all match.',
      notComparableTitle: 'Recorded, but not compared',
      notComparableBody:
        'These sets are shown exactly as you logged them. They carry no record or trend, because what their number means cannot be compared.',
      snapshotOnlyGroup: 'Saved workout snapshot — not linked to the current catalog',
      baselineResult: 'First comparable result',
      baselineNote: 'A first result is a starting point, not a personal record.',
      loadRecord: 'Heaviest so far',
      loadRecordAssisted: 'Least assistance so far',
      repsRecord: 'Most reps at this weight',
      comparedAgainst: 'Compared against {count} earlier sets on the same setup',
      comparedAgainstOne: 'Compared against 1 earlier set on the same setup',
      previousBest: 'Previous best {load}',
      bestLabel: 'Best recorded',
      setsLabel: 'Sets done',
      volumeLabel: 'Total weight moved',
      volumePerSide: 'Total weight moved, per side',
      strengthTableCaption: 'Every finished set in this group, oldest first',
      columnReps: 'Reps',
      columnLoad: 'Weight',
      columnNotes: 'Records',
      singleResultNote: 'One finished set. There is nothing earlier to compare it with yet.',

      /* Volume refusals -------------------------------------------------- */
      volumeUnavailable: {
        no_completed_sets: 'No set here was marked done, so there is nothing to total.',
        basis_not_summable:
          'These numbers do not add up into weight moved. Assisted weight counts downwards, and bodyweight and unknown carry no external number.',
        mixed_basis: 'The sets here do not all mean the same thing by their number.',
        mixed_side: 'Left, right, and both cannot be added together.',
        incomplete_data: 'At least one finished set recorded no weight or no reps.',
      },

      /* Consistency ------------------------------------------------------ */
      consistencyHeading: 'What you logged',
      consistencyEmpty: 'Nothing is logged in this range.',
      workoutsLogged: '{count} workouts logged',
      workoutsLoggedOne: '1 workout logged',
      activeWeeks: '{active} of {spanned} weeks in this range have a logged workout',
      activeWeeksOne: '1 week in this range has a logged workout',
      workoutsLabel: 'Workouts',
      activeWeeksLabel: 'Weeks logged',
      routineLabel: 'Started from a routine',
      weekOf: 'Week of {day}',
      weekCount: '{count} logged',
      fromRoutine: '{count} started from a saved routine',
      fromRoutineNone: 'None of these were started from a saved routine',
      consistencyNote:
        'These are counts of what you recorded. Weeks with nothing logged are not listed, because a week nobody wrote in is not a week with zero workouts in it.',

      /* Muscle coverage --------------------------------------------------- */
      coverageHeading: 'Areas logged each week',
      coverageEmpty: 'No finished strength work is in this range.',
      coverageLead: 'Read from the exercise recorded in each activity, not from the machine alone.',
      coverageClassificationNote:
        'This uses your catalog’s exercise-to-muscle mapping as it stands today, applied to past logs. Correcting an exercise in the catalog changes what earlier weeks show here. It is not a snapshot taken at the time.',
      coveragePrimary: 'Logged this week',
      coverageSecondary: 'Also worked',
      coverageNone: 'No logged activity for this week',
      coverageUnmapped: 'Not mapped to a muscle area',
      coverageUnmappedBody:
        'These activities were logged, but the exercise they refer to is not available to read muscles from. They are listed rather than dropped, so the week is not reported as covering less than it did.',
      coverageEditHint: 'Muscle areas are edited on the exercise in your catalog.',
    },
    settings: {
      title: 'Settings',
      heading: 'Settings',
      lead: 'Preferences, data location, and backups.',
      dataTitle: 'Where your data lives',
      dataBody:
        'Workouts are stored in this browser on this device, using IndexedDB. Nothing is uploaded, and there is no account. Data does not sync to your other devices, and clearing this browser’s site data will remove it.',
      preferencesTitle: 'Preferences',
      preferencesBody:
        'These set what new entries default to. They never change a number you have already recorded: 50 lb logged last week stays 50 lb.',
      preferredLoadUnitLabel: 'Preferred weight unit',
      loadIncrementKgLabel: 'Step size in kilograms',
      loadIncrementLbLabel: 'Step size in pounds',
      defaultRestLabel: 'Default rest between sets (seconds)',
      save: 'Save preferences',
      saved: 'Preferences saved',
      errorTitle: 'Preferences were not saved',
      positiveNumberError: 'Enter a number greater than zero.',
      wholeSecondsError: 'Enter a whole number of seconds, zero or more.',
      loading: 'Loading your preferences',

      /* Backup ----------------------------------------------------------- */
      backupTitle: 'Backup',
      backupBody:
        'A backup is a single JSON file holding everything: your machines, every workout, your photos, and these preferences. Keep it somewhere you trust — it is a plain readable file, and Gym Tracker does not encrypt it.',
      exportAction: 'Export a backup',
      exportPending: 'Preparing your backup',
      exportRequestedTitle: 'Your browser was asked to save the backup',
      exportRequestedBody:
        'Check your downloads to confirm the file arrived. Gym Tracker cannot see where it went, or whether it was kept.',
      exportUnsupportedTitle: 'This browser would not start the download',
      exportUnsupportedBody:
        'Nothing was changed. Try a different browser, or check whether downloads are blocked for this site.',
      exportFailedTitle: 'The backup was not created',
      exportFailedBody:
        'Nothing on this device was changed. This usually means storage is full, or a record could not be read.',
      exportRetry: 'Try again',
      lastBackupNever: 'No backup has been exported from this device yet.',
      lastBackupOn: 'Last exported {date}.',

      /* Import ----------------------------------------------------------- */
      importTitle: 'Restore from a backup',
      importBody:
        'Choose a file to see what is in it. Nothing on this device changes until you pick Add as copy or Replace.',
      importChooseLabel: 'Choose a backup file',
      importReading: 'Checking the file',
      importCancel: 'Cancel',
      importClear: 'Choose a different file',
      importSelectedFile: 'Selected file: {name}',
      previewTitle: 'What this file contains',
      previewExportedAt: 'Exported {date} by version {appVersion}.',
      previewFormat: 'Backup format {formatVersion}, database schema {schemaVersion}.',
      previewMachines: 'Machines',
      previewExercises: 'Exercises',
      previewTemplates: 'Saved routines',
      previewWorkouts: 'Workouts',
      previewBreakdownLabel: 'How they ended',
      previewWorkoutBreakdown: '{completed} finished, {cancelled} cancelled, {inProgress} open',
      previewDeleted: 'Deleted workouts (restorable)',
      previewCustom: 'Machines you added yourself',
      previewPhotos: 'Your own photos',
      previewSets: 'Strength sets',
      previewSegments: 'Cardio segments',
      previewActiveWorkout: 'This file was exported while a workout was open.',
      previewIntegrityOk: 'The file’s checksum matches its contents.',

      addCopyTitle: 'Add as copy',
      addCopyBody:
        'Adds everything in the file beside what is already here. Nothing is overwritten: every imported machine, workout, and photo arrives with a new identity, and your current preferences are left alone.',
      addCopyAction: 'Add as copy',
      replaceTitle: 'Replace everything',
      replaceBody:
        'Removes every workout, machine, photo, and preference on this device and puts the file’s contents in their place. This cannot be undone from inside the app, which is why a backup of what is here now must be saved first.',
      replaceAction: 'Replace everything on this device',
      replaceSafetyAction: 'Save a backup of what is here now',
      replaceSafetyPending: 'Preparing a backup of this device',
      replaceSafetyDone:
        'A backup of this device’s current data was sent to your downloads. Check that it arrived before continuing.',
      replaceSafetyRequired: 'Save the backup above before replacing anything.',
      replaceSafetyStaleTitle: 'This device changed after that backup was prepared',
      replaceSafetyStaleBody:
        'Something was recorded or changed here since — in another tab, or on this page. Nothing was replaced, because the backup sent to your downloads no longer contains everything Replace would remove. Prepare a new one and try again.',
      replaceConfirmTitle: 'Replace everything on this device?',
      replaceConfirmBody:
        'Every workout, machine, photo, and preference currently on this device will be removed and replaced by the contents of this file.',
      replaceConfirmAction: 'Replace everything',
      replaceConfirmCancel: 'Keep my data',

      importApplying: 'Importing',
      importStepClearing: 'Removing the current data',
      importStepCatalog: 'Writing machines and exercises',
      importStepWorkouts: 'Writing workouts',
      importStepMedia: 'Writing photos',
      importStepSettings: 'Writing preferences',
      importStepVerifying: 'Checking what was written',
      importAddedTitle: 'The backup was added',
      importAddedBody: '{count} records were added beside what was already here.',
      importReplacedTitle: 'This device now holds the backup’s data',
      importReplacedBody: '{count} records were restored.',
      importDroppedReferences:
        '{count} imported activities had lost their link to a machine or exercise. They kept the names they were recorded with, exactly as they had them.',
      importFailedTitle: 'The import was not applied',
      importFailedBody:
        'Nothing on this device was changed — the whole import is applied together or not at all. You can try again with the same file.',
      importRetry: 'Try again',

      rejectUnrecognizedTitle: 'This is not a Gym Tracker backup',
      rejectUnrecognizedBody:
        'The file does not identify itself as one. Nothing was read from it beyond that.',
      rejectNotJsonTitle: 'This file could not be read',
      rejectNotJsonBody: 'It is not valid JSON, so there is nothing to check.',
      rejectTooLargeTitle: 'This file is too large to open',
      rejectTooLargeBody: 'It is larger than any backup this app can produce.',
      rejectFutureVersionTitle: 'This backup came from a newer version',
      rejectFutureVersionBody:
        'It is format {schemaVersion}; this build understands {supportedVersion}. Reading part of it could store records this version does not understand, so none of it is read.',
      rejectLegacyVersionTitle: 'This backup predates the integrity check',
      rejectLegacyVersionBody:
        'Format {schemaVersion} carries no checksum, so there is no way to tell whether it is intact. No released version of Gym Tracker could produce one.',
      rejectUnsupportedSchemaTitle: 'This backup was written by a different database version',
      rejectUnsupportedSchemaBody:
        'Its records are in database shape {appSchemaVersion}; this build restores {supported}. Converting between them is not something this version can do, so nothing was read from it.',
      rejectIntegrityTitle: 'This file has changed since it was written',
      rejectIntegrityBody:
        'Its checksum does not match its contents, so something in it is not what was exported — a truncated download, a failing disk, or an edit. It is not imported.',
      rejectInvalidTitle: 'This backup is not usable',
      rejectInvalidBody:
        '{count} records or relationships in it do not make sense together, so none of it is imported.',
      rejectMediaTitle: 'A photo in this backup is not what it claims to be',
      rejectMediaBody:
        '{count} photos did not match their own records once decoded. Nothing was imported.',
      rejectConflictTitle: 'Adding this backup would leave two workouts open',
      rejectConflictBody:
        'This file was exported with a workout in progress, and one is in progress here too. Finish or cancel one of them first — neither was changed.',

      /* Privacy ---------------------------------------------------------- */
      privacyTitle: 'Your data and your privacy',
      privacyStorage:
        'Everything you log is stored by this browser, for this website, on this device. There is no account and no server.',
      privacyNoNetwork:
        'Gym Tracker sends nothing anywhere. There is no cloud sync, no telemetry, no analytics, and no advertising.',
      privacyNoSync:
        'Your phone and your computer keep separate data. Nothing moves between them on its own.',
      privacyClearing:
        'Clearing this browser’s site data, or losing the browser profile, removes the only copy on this device. A backup file is the way to keep another.',
      privacyBackupContents:
        'An exported backup contains your workout notes, your catalog, your preferences, and your photos, in readable form.',
      privacyBackupNotEncrypted:
        'Gym Tracker does not encrypt backups. Anyone who opens the file can read it, so keep it somewhere you would keep a private document.',
      privacyChecksum:
        'Each backup carries a SHA-256 checksum. It detects a file that has been damaged or altered since it was written. It is not encryption, it does not prove who wrote the file, and someone who deliberately changes both the contents and the checksum can defeat it.',
    },
    notFound: {
      title: 'Page not found',
      heading: 'Page not found',
      lead: 'That address does not match any page in Gym Tracker.',
      backToToday: 'Go to Today',
    },
  },
  mutation: {
    errorTitle: 'That change was not saved',
    errorBody:
      'Nothing on this device was changed. This usually means storage is full or the database is busy.',
    retry: 'Try again',
    dismiss: 'Dismiss',
    saving: 'Saving',
  },
  database: {
    initializingTitle: 'Opening your workout database',
    initializingBody: 'This takes a moment the first time.',
    errorTitle: 'Your workout database could not be opened',
    errorBody:
      'Nothing has been lost or changed. This usually happens in a private window, when browser storage is blocked, or when another tab is holding an older version of the app open.',
    errorRecovery: 'Close other Gym Tracker tabs, then try again.',
    retry: 'Try again',
    readyStatus: 'Workout database ready',
  },
  /**
   * Installing, updating, and running without a connection.
   *
   * Two rules govern this copy. It never promises that an update is safe to apply during
   * a workout, because it is not; and it never describes a browser's refusal to offer an
   * install as something the user did wrong, because it is not that either.
   */
  pwa: {
    updateTitle: 'A newer version of Gym Tracker is ready',
    updateBody:
      'It has already been downloaded. Nothing changes until you apply it, and applying it reloads the app.',
    updateNow: 'Update now',
    updateLater: 'Later',
    updateApplyingTitle: 'Applying the update',
    updateBlockedBody:
      'A workout is open. Applying an update reloads the app, so finish or cancel the workout first — the update will still be here.',
    updateFailedTitle: 'The update was not applied',
    updateFailedBody:
      'You are still running the version you started with, and nothing was lost. You can try again.',
    updateRetry: 'Try again',

    sectionTitle: 'Installing and updating',
    installedTitle: 'Installed on this device',
    installedBody:
      'Open Gym Tracker from your home screen or app list. It uses the same storage as the browser tab on this device.',
    installAvailableTitle: 'Add Gym Tracker to this device',
    installAvailableBody:
      'It opens in its own window and keeps working when the connection drops. Nothing is uploaded, and no account is created.',
    installAction: 'Install Gym Tracker',
    installDismissedTitle: 'Not installed',
    installDismissedBody:
      'You closed the install prompt. Your browser may offer it again later, or you can install from its menu.',
    installManualTitle: 'Installing from your browser',
    installManualBody:
      'This browser does not offer Gym Tracker an install button of its own. Look for “Install app” or “Add to Home screen” in the browser’s menu.',

    offlineReadyTitle: 'Ready without a connection',
    offlineReadyBody:
      'The app and your machine photos are stored on this device, so a workout can be started, logged, and finished with no signal.',
    offlineNotReadyTitle: 'Not yet ready without a connection',
    offlineNotReadyBody:
      'Stay on this page for a moment while the app finishes storing itself, then reload once.',
    offlineUnsupportedTitle: 'This browser cannot store the app',
    offlineUnsupportedBody:
      'Your workouts are still saved on this device. The app itself will need a connection to open.',
    registrationFailedTitle: 'The app could not store itself for later',
    registrationFailedBody:
      'Your workouts are still saved on this device and nothing was lost. This usually happens in a private window or when the page is not served over HTTPS.',

    updateAvailableSettingsTitle: 'An update is waiting',
    updateNoneTitle: 'You are on the current version',
    updateNoneBody: 'Gym Tracker checks for a newer version each time it opens.',
  },
  /**
   * The backup reminder, in one place.
   *
   * Today and Settings both show it, so the sentence lives outside either page's
   * namespace -- the alternative is one sentence written twice and translated twice, which
   * is how two screens end up saying slightly different things about the same fact.
   *
   * The wording states what is true and stops. No streak, no "you should", no counter of
   * how many days were missed: this app does not scold, and a backup notice is not the
   * place to start.
   */
  backupReminder: {
    dueTitle: 'It has been {days} days since your last backup',
    dueBody:
      'Your workouts are stored only in this browser. Exporting a file takes a moment and gives you a second copy.',
    neverTitle: 'You have workouts recorded and no backup yet',
    neverBody:
      'Everything you have logged lives in this browser on this device. Clearing site data would remove it.',
    openSettings: 'Go to backup in Settings',
  },
  common: {
    loading: 'Loading',
    loadingScreen: 'Loading this screen',
    routeLoadFailedTitle: 'This screen could not be loaded',
    routeLoadFailedBody:
      'The app is still open and your stored data was not changed. Reload this screen to try downloading it again.',
    reloadScreen: 'Reload this screen',
    comingLater: 'Not implemented yet',
  },
  /**
   * Field-level validation messages, in one place.
   *
   * They used to live under the workout page, which was fine while the workout screen was
   * the only thing that edited a recorded row. History corrects the same rows under the
   * same rules, so keeping two copies of "enter a time like 16:00" would mean a
   * translator translating one sentence twice and the two eventually drifting apart.
   */
  validation: {
    number: 'Enter a number, or leave it blank.',
    wholeNumber: 'Enter a whole number, or leave it blank.',
    duration: 'Enter a time like 16:00, or leave it blank.',
    rpe: 'Enter a number from 1 to 10.',
    rir: 'Enter a whole number from 0 to 20.',
    heartRateOrder: 'The average cannot be higher than the maximum.',
  },
  machineCategory: {
    cardio: 'Cardio',
    lower_body: 'Lower body',
    upper_body: 'Upper body',
    full_body: 'Full body',
    other: 'Other',
  },
  loadingKind: {
    selectorized: 'Weight stack',
    plate_loaded: 'Plate loaded',
    cable: 'Cable',
    bodyweight: 'Bodyweight',
    cardio: 'Cardio',
    other: 'Other',
  },
  muscleGroup: {
    chest: 'Chest',
    back: 'Back',
    shoulders: 'Shoulders',
    biceps: 'Biceps',
    triceps: 'Triceps',
    forearms: 'Forearms',
    core: 'Core',
    glutes: 'Glutes',
    hips: 'Hips',
    quadriceps: 'Quadriceps',
    hamstrings: 'Hamstrings',
    calves: 'Calves',
    full_body: 'Full body',
    other: 'Other',
  },
  movementPattern: {
    push: 'Push',
    pull: 'Pull',
    squat: 'Squat',
    hinge: 'Hinge',
    lunge: 'Lunge',
    carry: 'Carry',
    isolation: 'Isolation',
    cardio: 'Cardio',
    other: 'Other',
  },
  identificationConfidence: {
    owner_confirmed: 'You confirmed this',
    high: 'Likely correct',
    medium: 'Possibly correct',
    low: 'Uncertain',
    unverified: 'Not checked',
  },
  loadBasisExplanation: {
    stack_display: 'The number printed beside the pin you selected.',
    per_side: 'The plates loaded on each side.',
    total_added: 'All the plates added, both sides together.',
    each_hand: 'The weight of each dumbbell or handle.',
    combined: 'The external weight, added together.',
    assisted: 'How much weight is taken off you. A smaller number is the harder set.',
    bodyweight: 'Your own weight, with nothing added.',
    unknown: 'Not recorded, so this number is not compared with anything.',
  },
  loadBasis: {
    stack_display: 'Stack display',
    per_side: 'Per side',
    total_added: 'Total added',
    each_hand: 'Each hand',
    combined: 'Combined',
    assisted: 'Assisted',
    bodyweight: 'Bodyweight',
    unknown: 'Unknown',
  },
  inclineType: {
    percent: 'Percent grade',
    level: 'Machine level',
    unknown: 'Unconfirmed',
  },
  cardioMode: {
    run: 'Run',
    walk: 'Walk',
    warmup: 'Warm-up',
    cooldown: 'Cool-down',
    custom: 'Other',
  },
  segmentStatus: {
    planned: 'Planned',
    completed: 'Done',
    skipped: 'Skipped',
  },
  setStatus: {
    planned: 'Planned',
    completed: 'Done',
    skipped: 'Skipped',
  },
  setType: {
    warmup: 'Warm-up',
    working: 'Working',
    drop: 'Drop',
    failure: 'To failure',
    custom: 'Other',
  },
  bodySide: {
    both: 'Both',
    left: 'Left',
    right: 'Right',
  },
  sessionStatus: {
    in_progress: 'In progress',
    completed: 'Finished',
    cancelled: 'Cancelled',
  },
  units: {
    kg: 'kg',
    lb: 'lb',
    km: 'km',
    mi: 'mi',
    kph: 'km/h',
    bpm: 'bpm',
  },
};

/**
 * The shape a translation must satisfy. Values widen to `string` deliberately: a
 * future `ar.ts` supplies different text, not different literal types.
 */
export type AppStrings = typeof en;
