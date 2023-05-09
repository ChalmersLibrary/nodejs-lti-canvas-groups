function downloadCsv(categoryId, categoryName) {
    window.location.href = "/csv/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function downloadCsvZoom(categoryId, categoryName) {
    window.location.href = "/csv/zoom/category/" + categoryId + "/" + categoryName.replace("/", "-").replace(" ", "%20");
}

function renderDashboard() {
    if ($('#chartContainer')) {
        let data_labels = [];
        var data_reads = [];
        var data_reads_total = 0;
        var data_writes = [];
        var data_writes_total = 0;

        $.getJSON('/json/stats').done(function(data) {
            $.each(data.cache_stats, function(index, value) {
                data_labels.push(value.name);
                data_reads.push(value.reads);
                data_writes.push(value.writes);
                data_reads_total = data_reads_total + value.reads;
                data_writes_total = data_writes_total + value.writes;
            });

            $('#active_users').text(data.active_users_today);
            $('#total_users').text(data.authorized_users);
            $('#total_reads').text(data_reads_total);
            $('#total_writes').text(data_writes_total);

            (data_reads_total > 0 && data_writes_total > 0) ? $('span.percent').text(' (' + Math.round((data_reads_total / data_writes_total) * 100) + '%)'): $('span.percent').text(' (0%)');

            var ctx = document.getElementById('chartContainer').getContext('2d');

            var myChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: data_labels,
                    datasets: [{
                            label: 'Cache writes',
                            data: data_writes,
                            backgroundColor: 'rgba(32, 161, 112, 1)',
                            borderWidth: 0
                        },
                        {
                            label: 'Cache reads',
                            data: data_reads,
                            backgroundColor: 'rgba(144, 144, 88, 1)',
                            borderWidth: 0
                        }
                    ]
                },
                options: {
                    scales: {
                        yAxes: [{
                            ticks: {
                                beginAtZero: true
                            }
                        }]
                    }
                }
            });
        });
    }
}

$(document).ready(function() {
    if (document.location.href.startsWith("/loading")) {
        setInterval(function () {
            var progress = document.getElementsByTagName('progress')[0];
            if (progress.value < progress.max) {
                progress.value > 30 && progress.value < 60 ? progress.value += 3 : progress.value += 1;
            }
        }, 900);
    }
    else if (document.location.href.startsWith("/groups")) {
        const btnDownloadCsv = document.getElementById("button-csv");
        const btnDownloadCsvZoom = document.getElementById("button-csv-zoom");

        btnDownloadCsv.addEventListener("click", downloadCsv(btnDownloadCsv.getAttribute("data-category-id"), btnDownloadCsv.getAttribute("data-category-name")));
        btnDownloadCsvZoom.addEventListener("click", downloadCsv(btnDownloadCsvZoom.getAttribute("data-category-id"), btnDownloadCsvZoom.getAttribute("data-category-name")));
    }
    else if (document.location.href.startsWith("/dashboard")) {
        renderDashboard();
        setInterval(renderDashboard, 600000); // Every 10 mins
    }
});